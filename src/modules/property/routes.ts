import { and, asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../core/audit.ts';
import { ctxOf } from '../../core/guards.ts';
import { expectedVersion } from '../../core/http.ts';
import { properties, roomTypes, rooms, type PropertySettings } from '../../db/schema/index.ts';
import { businessDate } from '../../lib/dates.ts';
import { conflict, notFound, preconditionFailed } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';

const P = z.object({ propertyId: z.uuid() });
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Время в формате ЧЧ:ММ');

export const SettingsDto = z
  .object({
    discountLimitPercent: z.number().int().min(0).max(100),
    refundLimit: z.number().int().min(0),
    breakfastPrice: z.number().int().min(0),
    prepaymentHours: z.number().int().min(1).max(720),
    autoCancelUnpaid: z.boolean(),
    requireInspectedForCheckIn: z.boolean(),
    generalCleaningWeekday: z.number().int().min(1).max(7),
    dailyCleaningDue: HHMM,
    scanRetentionDays: z.number().int().min(1).max(3650),
    specialPriceBases: z.array(z.string().min(1).max(120)).max(30),
    cancelReasons: z.array(z.string().min(1).max(120)).max(30),
    noShowReasons: z.array(z.string().min(1).max(120)).max(30),
    stornoReasons: z.array(z.string().min(1).max(120)).max(30),
  })
  .meta({ id: 'PropertySettings' });

export const PropertyDto = z
  .object({
    id: z.uuid(),
    name: z.string(),
    timezone: z.string(),
    currency: z.string(),
    checkInTime: z.string(),
    checkOutTime: z.string(),
    address: z.string().nullable(),
    phone: z.string().nullable(),
    businessDate: z.iso.date().describe('Операционная дата гостиницы: сутки начинаются в 06:00 по её времени'),
    settings: SettingsDto,
    version: z.number().int(),
  })
  .meta({ id: 'Property' });

export const RoomTypeDto = z
  .object({
    id: z.uuid(),
    code: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    baseOccupancy: z.number().int(),
    maxOccupancy: z.number().int(),
    sort: z.number().int(),
    isActive: z.boolean(),
  })
  .meta({ id: 'RoomType' });

export const HkStatus = z.enum(['dirty', 'cleaning', 'clean', 'inspected', 'repair']).meta({ id: 'HkStatus' });

export const RoomDto = z
  .object({
    id: z.uuid(),
    number: z.string(),
    roomTypeId: z.uuid(),
    floor: z.number().int().nullable(),
    note: z.string().nullable(),
    sort: z.number().int(),
    isActive: z.boolean(),
    hkStatus: HkStatus,
    hkStatusAt: z.iso.datetime(),
    dnd: z.boolean(),
    version: z.number().int(),
  })
  .meta({ id: 'Room' });

type PropertyRow = typeof properties.$inferSelect;
type RoomRow = typeof rooms.$inferSelect;
type RoomTypeRow = typeof roomTypes.$inferSelect;

export function propertyDto(p: PropertyRow) {
  return {
    id: p.id,
    name: p.name,
    timezone: p.timezone,
    currency: p.currency,
    checkInTime: p.checkInTime.slice(0, 5),
    checkOutTime: p.checkOutTime.slice(0, 5),
    address: p.address,
    phone: p.phone,
    businessDate: businessDate(new Date(), p.timezone),
    settings: p.settings,
    version: p.version,
  };
}

export function roomDto(r: RoomRow) {
  return {
    id: r.id,
    number: r.number,
    roomTypeId: r.roomTypeId,
    floor: r.floor,
    note: r.note,
    sort: r.sort,
    isActive: r.isActive,
    hkStatus: r.hkStatus,
    hkStatusAt: r.hkStatusAt.toISOString(),
    dnd: r.dnd,
    version: r.version,
  };
}

export function roomTypeDto(t: RoomTypeRow) {
  return {
    id: t.id,
    code: t.code,
    name: t.name,
    description: t.description,
    baseOccupancy: t.baseOccupancy,
    maxOccupancy: t.maxOccupancy,
    sort: t.sort,
    isActive: t.isActive,
  };
}

export const propertyRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = app.deps.db;

  app.get(
    '',
    { schema: { tags: ['Гостиница'], summary: 'Гостиница, операционная дата и настройки', params: P, response: { 200: PropertyDto } } },
    async (req) => {
      const ctx = ctxOf(req);
      const [p] = await db.select().from(properties).where(eq(properties.id, ctx.propertyId));
      return propertyDto(p!);
    },
  );

  app.patch(
    '/settings',
    {
      schema: {
        tags: ['Гостиница'],
        summary: 'Изменить настройки и лимиты гостиницы',
        description: 'Лимиты скидки и возврата без согласования задаёт управляющий (ТЗ). Нужен If-Match с версией.',
        params: P,
        body: z.object({
          checkInTime: HHMM.optional(),
          checkOutTime: HHMM.optional(),
          address: z.string().max(300).nullable().optional(),
          phone: z.string().max(50).nullable().optional(),
          settings: SettingsDto.partial().optional(),
          version: z.number().int().optional(),
        }),
        response: { 200: PropertyDto },
      },
      config: { permission: 'settings.manage' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const version = expectedVersion(req, req.body.version);
      return db.transaction(async (tx) => {
        const [before] = await tx.select().from(properties).where(eq(properties.id, ctx.propertyId)).for('update');
        if (!before) throw notFound('property.not_found', 'Гостиница не найдена');
        if (before.version !== version) throw preconditionFailed('Настройки уже изменил другой сотрудник', undefined, { currentVersion: before.version });
        const settings: PropertySettings = { ...before.settings, ...(req.body.settings ?? {}) };
        const [after] = await tx
          .update(properties)
          .set({
            settings,
            checkInTime: req.body.checkInTime ?? before.checkInTime,
            checkOutTime: req.body.checkOutTime ?? before.checkOutTime,
            address: req.body.address !== undefined ? req.body.address : before.address,
            phone: req.body.phone !== undefined ? req.body.phone : before.phone,
            updatedAt: new Date(),
            version: before.version + 1,
          })
          .where(eq(properties.id, ctx.propertyId))
          .returning();
        await audit(tx, ctx, {
          action: 'property.settings',
          entityType: 'property',
          entityId: ctx.propertyId,
          entityLabel: before.name,
          before: { ...before.settings, checkInTime: before.checkInTime, checkOutTime: before.checkOutTime },
          after: { ...after!.settings, checkInTime: after!.checkInTime, checkOutTime: after!.checkOutTime },
        });
        return propertyDto(after!);
      });
    },
  );

  app.get(
    '/room-types',
    { schema: { tags: ['Номерной фонд'], summary: 'Типы номеров', params: P, response: { 200: z.array(RoomTypeDto) } } },
    async (req) => {
      const ctx = ctxOf(req);
      const rows = await db
        .select()
        .from(roomTypes)
        .where(eq(roomTypes.propertyId, ctx.propertyId))
        .orderBy(asc(roomTypes.sort), asc(roomTypes.name));
      return rows.map(roomTypeDto);
    },
  );

  app.post(
    '/room-types',
    {
      schema: {
        tags: ['Номерной фонд'],
        summary: 'Добавить тип номера',
        params: P,
        body: z.object({
          code: z.string().min(1).max(12),
          name: z.string().min(1).max(80),
          description: z.string().max(500).nullable().optional(),
          baseOccupancy: z.number().int().min(1).max(12),
          maxOccupancy: z.number().int().min(1).max(12),
          sort: z.number().int().default(0),
        }),
        response: { 201: RoomTypeDto },
      },
      config: { permission: 'settings.manage' },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(roomTypes)
          .values({ id: newId(), propertyId: ctx.propertyId, ...req.body, description: req.body.description ?? null })
          .returning();
        await audit(tx, ctx, { action: 'room_type.create', entityType: 'room_type', entityId: row!.id, entityLabel: row!.name, after: roomTypeDto(row!) });
        return row!;
      });
      return reply.status(201).send(roomTypeDto(created));
    },
  );

  app.patch(
    '/room-types/:id',
    {
      schema: {
        tags: ['Номерной фонд'],
        summary: 'Изменить тип номера',
        params: P.extend({ id: z.uuid() }),
        body: z.object({
          name: z.string().min(1).max(80).optional(),
          description: z.string().max(500).nullable().optional(),
          baseOccupancy: z.number().int().min(1).max(12).optional(),
          maxOccupancy: z.number().int().min(1).max(12).optional(),
          sort: z.number().int().optional(),
          isActive: z.boolean().optional(),
        }),
        response: { 200: RoomTypeDto },
      },
      config: { permission: 'settings.manage' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      return db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(roomTypes)
          .where(and(eq(roomTypes.id, req.params.id), eq(roomTypes.propertyId, ctx.propertyId)))
          .for('update');
        if (!before) throw notFound('room_type.not_found', 'Тип номера не найден');
        const [after] = await tx.update(roomTypes).set(req.body).where(eq(roomTypes.id, before.id)).returning();
        await audit(tx, ctx, { action: 'room_type.update', entityType: 'room_type', entityId: before.id, entityLabel: after!.name, before: roomTypeDto(before), after: roomTypeDto(after!) });
        return roomTypeDto(after!);
      });
    },
  );

  app.get(
    '/rooms',
    { schema: { tags: ['Номерной фонд'], summary: 'Номера', params: P, response: { 200: z.array(RoomDto) } } },
    async (req) => {
      const ctx = ctxOf(req);
      const rows = await db.select().from(rooms).where(eq(rooms.propertyId, ctx.propertyId)).orderBy(asc(rooms.sort), asc(rooms.number));
      return rows.map(roomDto);
    },
  );

  app.post(
    '/rooms',
    {
      schema: {
        tags: ['Номерной фонд'],
        summary: 'Добавить номер',
        params: P,
        body: z.object({
          number: z.string().min(1).max(12),
          roomTypeId: z.uuid(),
          floor: z.number().int().min(-5).max(100).nullable().optional(),
          note: z.string().max(300).nullable().optional(),
          sort: z.number().int().default(0),
        }),
        response: { 201: RoomDto },
      },
      config: { permission: 'settings.manage' },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      const created = await db.transaction(async (tx) => {
        const [type] = await tx
          .select()
          .from(roomTypes)
          .where(and(eq(roomTypes.id, req.body.roomTypeId), eq(roomTypes.propertyId, ctx.propertyId)));
        if (!type) throw notFound('room_type.not_found', 'Тип номера не найден');
        const [dup] = await tx
          .select({ id: rooms.id })
          .from(rooms)
          .where(and(eq(rooms.propertyId, ctx.propertyId), eq(rooms.number, req.body.number)));
        if (dup) throw conflict('room.number_taken', `Номер ${req.body.number} уже есть`);
        const [row] = await tx
          .insert(rooms)
          .values({
            id: newId(),
            propertyId: ctx.propertyId,
            number: req.body.number,
            roomTypeId: type.id,
            floor: req.body.floor ?? null,
            note: req.body.note ?? null,
            sort: req.body.sort,
          })
          .returning();
        await audit(tx, ctx, { action: 'room.create', entityType: 'room', entityId: row!.id, entityLabel: `Номер ${row!.number}`, after: roomDto(row!) });
        return row!;
      });
      return reply.status(201).send(roomDto(created));
    },
  );

  app.patch(
    '/rooms/:id',
    {
      schema: {
        tags: ['Номерной фонд'],
        summary: 'Изменить номер (не статус уборки)',
        params: P.extend({ id: z.uuid() }),
        body: z.object({
          number: z.string().min(1).max(12).optional(),
          roomTypeId: z.uuid().optional(),
          floor: z.number().int().min(-5).max(100).nullable().optional(),
          note: z.string().max(300).nullable().optional(),
          sort: z.number().int().optional(),
          isActive: z.boolean().optional(),
          version: z.number().int().optional(),
        }),
        response: { 200: RoomDto },
      },
      config: { permission: 'settings.manage' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const version = expectedVersion(req, req.body.version);
      const { version: _v, ...patch } = req.body;
      return db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(rooms)
          .where(and(eq(rooms.id, req.params.id), eq(rooms.propertyId, ctx.propertyId)))
          .for('update');
        if (!before) throw notFound('room.not_found', 'Номер не найден');
        if (before.version !== version) throw preconditionFailed('Номер уже изменил другой сотрудник', undefined, { currentVersion: before.version });
        const [after] = await tx
          .update(rooms)
          .set({ ...patch, version: before.version + 1 })
          .where(eq(rooms.id, before.id))
          .returning();
        await audit(tx, ctx, { action: 'room.update', entityType: 'room', entityId: before.id, entityLabel: `Номер ${after!.number}`, before: roomDto(before), after: roomDto(after!) });
        return roomDto(after!);
      });
    },
  );
};
