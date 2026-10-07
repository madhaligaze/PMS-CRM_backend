import { aliasedTable, and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, emit } from '../../core/audit.ts';
import { can, requirePermission, type PropertyContext } from '../../core/context.ts';
import { nextNumber } from '../../core/counters.ts';
import type { Deps } from '../../core/deps.ts';
import { ctxOf } from '../../core/guards.ts';
import { iso, Problem } from '../../core/http.ts';
import type { DbOrTx } from '../../db/client.ts';
import { maintenanceRequests, roomBlocks, rooms, users } from '../../db/schema/index.ts';
import { badRequest, conflict, forbidden, notFound, pgCode } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { trimOrNull } from '../../lib/normalize.ts';
import { createBlock, overlapError, releaseBlock, today } from '../bookings/service.ts';
import { createTask } from '../housekeeping/service.ts';

const P = z.object({ propertyId: z.uuid() });
const PI = P.extend({ id: z.uuid() });
const Urgency = z.enum(['low', 'normal', 'high', 'critical']).meta({ id: 'Urgency' });
const MStatus = z.enum(['open', 'in_progress', 'done', 'cancelled']).meta({ id: 'MaintenanceStatus' });

export const MaintenanceDto = z
  .object({
    id: z.uuid(),
    number: z.number().int(),
    roomId: z.uuid().nullable(),
    roomNumber: z.string().nullable(),
    location: z.string().nullable(),
    title: z.string(),
    description: z.string().nullable(),
    urgency: Urgency,
    status: MStatus,
    block: z.object({ id: z.uuid(), startsOn: z.iso.date(), endsOn: z.iso.date(), isActive: z.boolean() }).nullable(),
    photoFileIds: z.array(z.uuid()),
    assigneeId: z.uuid().nullable(),
    assigneeName: z.string().nullable(),
    takenAt: z.iso.datetime().nullable(),
    closedAt: z.iso.datetime().nullable(),
    closedBy: z.string().nullable(),
    closeComment: z.string().nullable(),
    closePhotoFileIds: z.array(z.uuid()),
    createdAt: z.iso.datetime(),
    createdBy: z.string(),
    createdById: z.uuid(),
    version: z.number().int(),
  })
  .meta({ id: 'MaintenanceRequest' });

const assignee = aliasedTable(users, 'assignee');
const creator = aliasedTable(users, 'creator');
const closer = aliasedTable(users, 'closer');

async function dtos(tx: DbOrTx, conds: SQL[]) {
  const rows = await tx
    .select({
      m: maintenanceRequests,
      roomNumber: rooms.number,
      block: roomBlocks,
      assigneeName: assignee.fullName,
      createdBy: creator.fullName,
      closedBy: closer.fullName,
    })
    .from(maintenanceRequests)
    .leftJoin(creator, eq(creator.id, maintenanceRequests.createdBy))
    .leftJoin(rooms, eq(rooms.id, maintenanceRequests.roomId))
    .leftJoin(roomBlocks, eq(roomBlocks.id, maintenanceRequests.blockId))
    .leftJoin(assignee, eq(assignee.id, maintenanceRequests.assigneeId))
    .leftJoin(closer, eq(closer.id, maintenanceRequests.closedBy))
    .where(and(...conds))
    .orderBy(desc(maintenanceRequests.createdAt));
  return rows.map((r) => ({
    id: r.m.id,
    number: r.m.number,
    roomId: r.m.roomId,
    roomNumber: r.roomNumber,
    location: r.m.location,
    title: r.m.title,
    description: r.m.description,
    urgency: r.m.urgency,
    status: r.m.status,
    block: r.block ? { id: r.block.id, startsOn: r.block.startsOn, endsOn: r.block.endsOn, isActive: r.block.isActive } : null,
    photoFileIds: r.m.photoFileIds,
    assigneeId: r.m.assigneeId,
    assigneeName: r.assigneeName,
    takenAt: iso(r.m.takenAt),
    closedAt: iso(r.m.closedAt),
    closedBy: r.closedBy,
    closeComment: r.m.closeComment,
    closePhotoFileIds: r.m.closePhotoFileIds,
    createdAt: r.m.createdAt.toISOString(),
    createdBy: r.createdBy ?? '',
    createdById: r.m.createdBy,
    version: r.m.version,
  }));
}

async function one(tx: DbOrTx, ctx: PropertyContext, id: string) {
  const [d] = await dtos(tx, [eq(maintenanceRequests.id, id), eq(maintenanceRequests.propertyId, ctx.propertyId)]);
  if (!d) throw notFound('maintenance.not_found', 'Заявка не найдена');
  return d;
}

async function load(tx: DbOrTx, ctx: PropertyContext, id: string) {
  const [m] = await tx
    .select()
    .from(maintenanceRequests)
    .where(and(eq(maintenanceRequests.id, id), eq(maintenanceRequests.propertyId, ctx.propertyId)))
    .for('update');
  if (!m) throw notFound('maintenance.not_found', 'Заявка не найдена');
  return m;
}

async function create(
  deps: Deps,
  ctx: PropertyContext,
  input: {
    roomId?: string | null | undefined;
    location?: string | null | undefined;
    title: string;
    description?: string | null | undefined;
    urgency: 'low' | 'normal' | 'high' | 'critical';
    photoFileIds?: string[] | undefined;
    blocksSale: boolean;
    blockFrom?: string | undefined;
    blockTo?: string | undefined;
  },
) {
  if (!input.roomId && !trimOrNull(input.location)) throw badRequest('maintenance.where', 'Укажите номер или место');
  if (input.blocksSale) {
    requirePermission(ctx, 'block.manage', 'Снять номер с продажи может старший администратор или супервайзер');
    if (!input.roomId) throw badRequest('maintenance.block_room', 'Блокировать можно только номер');
  }
  const blockFrom = input.blockFrom ?? today(ctx);
  const blockTo = input.blockTo;
  if (input.blocksSale && (!blockTo || blockTo <= blockFrom)) {
    throw badRequest('maintenance.block_dates', 'Укажите, до какой даты номер не продаётся');
  }
  try {
    return await deps.db.transaction(async (tx) => {
      if (input.roomId) {
        const [room] = await tx.select().from(rooms).where(and(eq(rooms.id, input.roomId), eq(rooms.propertyId, ctx.propertyId)));
        if (!room) throw notFound('room.not_found', 'Номер не найден');
      }
      const id = newId();
      const number = await nextNumber(tx, ctx.propertyId, 'maintenance');
      await tx.insert(maintenanceRequests).values({
        id,
        propertyId: ctx.propertyId,
        number,
        roomId: input.roomId ?? null,
        location: trimOrNull(input.location),
        title: input.title.trim(),
        description: trimOrNull(input.description),
        urgency: input.urgency,
        photoFileIds: input.photoFileIds ?? [],
        createdBy: ctx.actor.id!,
      });
      if (input.blocksSale && input.roomId && blockTo) {
        const blockId = await createBlock(
          deps,
          ctx,
          { roomId: input.roomId, startsOn: blockFrom, endsOn: blockTo, reason: `Ремонт: ${input.title.trim()} (заявка ${number})`, maintenanceRequestId: id },
          tx,
        );
        await tx.update(maintenanceRequests).set({ blockId }).where(eq(maintenanceRequests.id, id));
      }
      await audit(tx, ctx, {
        action: 'maintenance.create',
        entityType: 'maintenance',
        entityId: id,
        entityLabel: `Заявка ${number}`,
        changes: { title: [null, input.title], urgency: [null, input.urgency], blocksSale: [null, input.blocksSale] },
      });
      await emit(tx, ctx, 'maintenance.changed', id, { roomId: input.roomId ?? null });
      return id;
    });
  } catch (err) {
    if (pgCode(err) === '23P01' && input.roomId && blockTo) throw await overlapError(deps.db, ctx, input.roomId, blockFrom, blockTo);
    throw err;
  }
}

export const maintenanceRoutes: FastifyPluginAsyncZod = async (app) => {
  const deps = app.deps;
  const db = deps.db;

  app.get(
    '/maintenance',
    {
      schema: {
        tags: ['Ремонт'],
        summary: 'Заявки на ремонт',
        description: 'Кто только создаёт заявки, видит свои; техник и руководители - все.',
        params: P,
        querystring: z.object({
          status: z
            .union([MStatus, z.array(MStatus)])
            .optional()
            .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
          roomId: z.uuid().optional(),
        }),
        response: { 200: z.array(MaintenanceDto) },
      },
      config: { permission: ['maintenance.view', 'maintenance.create'] },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const conds: SQL[] = [eq(maintenanceRequests.propertyId, ctx.propertyId)];
      if (req.query.status?.length) conds.push(inArray(maintenanceRequests.status, req.query.status));
      if (req.query.roomId) conds.push(eq(maintenanceRequests.roomId, req.query.roomId));
      if (!can(ctx, 'maintenance.view')) conds.push(eq(maintenanceRequests.createdBy, ctx.actor.id!));
      return dtos(db, conds);
    },
  );

  app.post(
    '/maintenance',
    {
      schema: {
        tags: ['Ремонт'],
        summary: 'Новая заявка на ремонт',
        description: 'Если ремонт мешает продаже, номер блокируется на шахматке на указанные даты.',
        params: P,
        body: z.object({
          roomId: z.uuid().nullable().optional(),
          location: z.string().trim().max(120).nullable().optional(),
          title: z.string().trim().min(1).max(200),
          description: z.string().trim().max(2000).nullable().optional(),
          urgency: Urgency.default('normal'),
          photoFileIds: z.array(z.uuid()).max(10).optional(),
          blocksSale: z.boolean().default(false),
          blockFrom: z.iso.date().optional(),
          blockTo: z.iso.date().optional(),
        }),
        response: { 201: MaintenanceDto, 409: Problem },
      },
      config: { permission: 'maintenance.create', idempotent: true },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      const id = await create(deps, ctx, req.body);
      return reply.status(201).send(await one(db, ctx, id));
    },
  );

  app.get(
    '/maintenance/:id',
    { schema: { tags: ['Ремонт'], summary: 'Заявка', params: PI, response: { 200: MaintenanceDto } }, config: { permission: ['maintenance.view', 'maintenance.create'] } },
    async (req) => {
      const ctx = ctxOf(req);
      const d = await one(db, ctx, req.params.id);
      if (!can(ctx, 'maintenance.view') && d.createdById !== ctx.actor.id) throw forbidden('maintenance.not_yours', 'Это чужая заявка');
      return d;
    },
  );

  app.post(
    '/maintenance/:id/take',
    { schema: { tags: ['Ремонт'], summary: 'Взять заявку в работу', params: PI, response: { 200: MaintenanceDto } }, config: { permission: 'maintenance.work' } },
    async (req) => {
      const ctx = ctxOf(req);
      await db.transaction(async (tx) => {
        const m = await load(tx, ctx, req.params.id);
        if (m.status !== 'open') throw conflict('maintenance.status', 'Взять можно только открытую заявку');
        await tx
          .update(maintenanceRequests)
          .set({ status: 'in_progress', assigneeId: ctx.actor.id, takenAt: new Date(), updatedAt: new Date(), version: m.version + 1 })
          .where(eq(maintenanceRequests.id, m.id));
        await audit(tx, ctx, {
          action: 'maintenance.take',
          entityType: 'maintenance',
          entityId: m.id,
          entityLabel: `Заявка ${m.number}`,
          changes: { status: ['open', 'in_progress'], assignee: [null, ctx.actor.name] },
        });
        await emit(tx, ctx, 'maintenance.changed', m.id);
      });
      return one(db, ctx, req.params.id);
    },
  );

  app.post(
    '/maintenance/:id/close',
    {
      schema: {
        tags: ['Ремонт'],
        summary: 'Закрыть заявку с комментарием и фото',
        description: 'Блокировка снимается, номер возвращается в уборку, затем в продажу.',
        params: PI,
        body: z.object({ comment: z.string().trim().min(1).max(2000), photoFileIds: z.array(z.uuid()).max(10).default([]) }),
        response: { 200: MaintenanceDto },
      },
      config: { permission: 'maintenance.work' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      await db.transaction(async (tx) => {
        const m = await load(tx, ctx, req.params.id);
        if (m.status !== 'open' && m.status !== 'in_progress') throw conflict('maintenance.status', 'Заявка уже закрыта');
        await tx
          .update(maintenanceRequests)
          .set({
            status: 'done',
            closedAt: new Date(),
            closedBy: ctx.actor.id,
            closeComment: req.body.comment,
            closePhotoFileIds: req.body.photoFileIds,
            assigneeId: m.assigneeId ?? ctx.actor.id,
            updatedAt: new Date(),
            version: m.version + 1,
          })
          .where(eq(maintenanceRequests.id, m.id));
        if (m.blockId) {
          await releaseBlock(tx, ctx, m.blockId, `Заявка ${m.number} закрыта`);
          if (m.roomId) await createTask(tx, ctx, { roomId: m.roomId, kind: 'request', note: `После ремонта: заявка ${m.number}` });
        }
        await audit(tx, ctx, {
          action: 'maintenance.close',
          entityType: 'maintenance',
          entityId: m.id,
          entityLabel: `Заявка ${m.number}`,
          changes: { status: [m.status, 'done'] },
          reason: req.body.comment,
        });
        await emit(tx, ctx, 'maintenance.changed', m.id, { roomId: m.roomId });
      });
      return one(db, ctx, req.params.id);
    },
  );

  app.post(
    '/maintenance/:id/cancel',
    {
      schema: {
        tags: ['Ремонт'],
        summary: 'Отменить заявку с причиной',
        params: PI,
        body: z.object({ reason: z.string().trim().min(1).max(500) }),
        response: { 200: MaintenanceDto },
      },
      config: { permission: ['maintenance.view', 'maintenance.create'] },
    },
    async (req) => {
      const ctx = ctxOf(req);
      await db.transaction(async (tx) => {
        const m = await load(tx, ctx, req.params.id);
        if (m.createdBy !== ctx.actor.id && !can(ctx, 'block.manage')) {
          throw forbidden('maintenance.not_yours', 'Отменить заявку может автор или руководитель');
        }
        if (m.status !== 'open' && m.status !== 'in_progress') throw conflict('maintenance.status', 'Заявка уже закрыта');
        await tx
          .update(maintenanceRequests)
          .set({ status: 'cancelled', closedAt: new Date(), closedBy: ctx.actor.id, closeComment: req.body.reason, updatedAt: new Date(), version: m.version + 1 })
          .where(eq(maintenanceRequests.id, m.id));
        if (m.blockId) await releaseBlock(tx, ctx, m.blockId, `Заявка ${m.number} отменена`);
        await audit(tx, ctx, {
          action: 'maintenance.cancel',
          entityType: 'maintenance',
          entityId: m.id,
          entityLabel: `Заявка ${m.number}`,
          changes: { status: [m.status, 'cancelled'] },
          reason: req.body.reason,
        });
        await emit(tx, ctx, 'maintenance.changed', m.id);
      });
      return one(db, ctx, req.params.id);
    },
  );
};
