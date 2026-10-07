import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ctxOf } from '../../core/guards.ts';
import { auditLog } from '../../db/schema/index.ts';
import { addDays, zonedToUtc } from '../../lib/dates.ts';
import { decodeCursor, PageQuery, pageOf, pageSchema } from '../../lib/pagination.ts';

const P = z.object({ propertyId: z.uuid() });

export const AuditEntryDto = z
  .object({
    id: z.number().int(),
    at: z.iso.datetime(),
    actorId: z.uuid().nullable(),
    actorName: z.string(),
    action: z.string(),
    entityType: z.string(),
    entityId: z.string(),
    entityLabel: z.string().nullable(),
    changes: z.record(z.string(), z.tuple([z.unknown(), z.unknown()])).nullable(),
    reason: z.string().nullable(),
  })
  .meta({ id: 'AuditEntry' });

export const auditRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = app.deps.db;

  app.get(
    '/audit',
    {
      schema: {
        tags: ['Журнал'],
        summary: 'Журнал действий: кто, что, когда, старое и новое значение',
        description: 'Журнал только пополняется: изменить или удалить запись не может никто, даже база.',
        params: P,
        querystring: PageQuery.extend({
          entityType: z.string().max(40).optional(),
          entityId: z.string().max(80).optional(),
          actorId: z.uuid().optional(),
          action: z.string().max(60).optional(),
          from: z.iso.date().optional(),
          to: z.iso.date().optional(),
          q: z.string().max(100).optional(),
        }),
        response: { 200: pageSchema(AuditEntryDto) },
      },
      config: { permission: 'audit.view' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const q = req.query;
      const tz = ctx.property.timezone;
      const conds: SQL[] = [sql`(${auditLog.propertyId} = ${ctx.propertyId} or (${auditLog.propertyId} is null and ${auditLog.orgId} = ${ctx.orgId}))`];
      if (q.entityType) conds.push(eq(auditLog.entityType, q.entityType));
      if (q.entityId) conds.push(eq(auditLog.entityId, q.entityId));
      if (q.actorId) conds.push(eq(auditLog.actorId, q.actorId));
      if (q.action) conds.push(sql`${auditLog.action} like ${q.action + '%'}`);
      if (q.from) conds.push(gte(auditLog.at, zonedToUtc(q.from, '00:00', tz)));
      if (q.to) conds.push(lte(auditLog.at, zonedToUtc(addDays(q.to, 1), '00:00', tz)));
      if (q.q?.trim()) {
        const t = '%' + q.q.trim().toLowerCase() + '%';
        conds.push(sql`(lower(coalesce(${auditLog.entityLabel}, '')) like ${t} or lower(${auditLog.actorName}) like ${t} or lower(coalesce(${auditLog.reason}, '')) like ${t})`);
      }
      const cursor = decodeCursor<[number]>(q.cursor);
      if (cursor) conds.push(sql`${auditLog.id} < ${cursor[0]}`);
      const rows = await db.select().from(auditLog).where(and(...conds)).orderBy(desc(auditLog.id)).limit(q.limit + 1);
      const page = pageOf(rows, q.limit, (r) => [r.id]);
      return {
        items: page.items.map((r) => ({
          id: r.id,
          at: r.at.toISOString(),
          actorId: r.actorId,
          actorName: r.actorName,
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId,
          entityLabel: r.entityLabel,
          changes: r.changes,
          reason: r.reason,
        })),
        nextCursor: page.nextCursor,
      };
    },
  );

  // История конкретной брони или гостя видна тем, кто видит саму сущность.
  app.get(
    '/audit/entity/:entityType/:entityId',
    {
      schema: {
        tags: ['Журнал'],
        summary: 'История изменений сущности (брони, гостя, номера, сотрудника, должности)',
        params: P.extend({ entityType: z.enum(['booking', 'guest', 'room', 'shift', 'maintenance', 'hk_task', 'user', 'position']), entityId: z.string().max(80) }),
        response: { 200: z.array(AuditEntryDto) },
      },
      config: { permission: ['audit.view', 'booking.view', 'guest.view', 'hk.view', 'maintenance.view', 'cash.view', 'staff.view'] },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const need: Record<string, string[]> = {
        booking: ['booking.view'],
        guest: ['guest.view'],
        room: ['hk.view', 'tape.view'],
        shift: ['cash.view'],
        maintenance: ['maintenance.view'],
        hk_task: ['hk.view'],
        user: ['staff.view'],
        position: ['staff.view'],
      };
      const allowed = ctx.permissions.has('audit.view') || (need[req.params.entityType] ?? []).some((p) => ctx.permissions.has(p as never));
      if (!allowed) return [];
      const rows = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, req.params.entityType), eq(auditLog.entityId, req.params.entityId), eq(auditLog.orgId, ctx.orgId)))
        .orderBy(desc(auditLog.id))
        .limit(200);
      return rows.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        actorId: r.actorId,
        actorName: r.actorName,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        entityLabel: r.entityLabel,
        changes: r.changes,
        reason: r.reason,
      }));
    },
  );
};
