import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ctxOf } from '../../core/guards.ts';
import { expectedVersion, Problem, setEtag } from '../../core/http.ts';
import { addDays } from '../../lib/dates.ts';
import { PageQuery, pageSchema } from '../../lib/pagination.ts';
import {
  BookingDto,
  BookingListItemDto,
  BookingStatus,
  CreateBookingInput,
  GroupDto,
  ReadinessDto,
  RoomBlockDto,
  TapeChartDto,
  UpdateBookingInput,
} from './schemas.ts';
import * as svc from './service.ts';
import { and, eq } from 'drizzle-orm';
import { roomBlocks, rooms } from '../../db/schema/index.ts';
import { badRequest, notFound } from '../../lib/errors.ts';

const P = z.object({ propertyId: z.uuid() });
const PI = P.extend({ id: z.uuid() });
const VersionBody = { version: z.number().int().optional() };

/** Версия для действий над бронью: If-Match необязателен, но если есть - проверяется. */
function optionalVersion(header: unknown, body?: number): number | null {
  if (typeof header === 'string' && header.trim()) {
    const m = header.match(/^(?:W\/)?"?(\d+)"?$/);
    if (m) return Number(m[1]);
  }
  return body ?? null;
}

export const bookingRoutes: FastifyPluginAsyncZod = async (app) => {
  const deps = app.deps;
  const db = deps.db;

  app.get(
    '/tape-chart',
    {
      schema: {
        tags: ['Шахматка'],
        summary: 'Шахматка: номера по строкам, даты по столбцам',
        description: 'Брони, пересекающие период [from, to), блокировки ремонта и загрузка по дням.',
        params: P,
        querystring: z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }),
        response: { 200: TapeChartDto },
      },
      config: { permission: 'tape.view' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const from = req.query.from ?? addDays(svc.today(ctx), -3);
      const to = req.query.to ?? addDays(from, 28);
      return svc.tapeChart(db, ctx, from, to);
    },
  );

  app.get(
    '/bookings',
    {
      schema: {
        tags: ['Брони'],
        summary: 'Брони: заезды и выезды дня, живущие, поиск',
        description: 'view=arrivals|departures|inhouse возвращают весь список дня без страниц.',
        params: P,
        querystring: PageQuery.extend({
          view: z.enum(['arrivals', 'departures', 'inhouse', 'all']).optional(),
          date: z.iso.date().optional(),
          status: z
            .union([BookingStatus, z.array(BookingStatus)])
            .optional()
            .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
          q: z.string().max(100).optional(),
          from: z.iso.date().optional(),
          to: z.iso.date().optional(),
          guestId: z.uuid().optional(),
        }),
        response: { 200: pageSchema(BookingListItemDto) },
      },
      config: { permission: 'booking.view' },
    },
    async (req) => svc.listBookings(db, ctxOf(req), req.query),
  );

  app.post(
    '/bookings',
    {
      schema: {
        tags: ['Брони'],
        summary: 'Новая бронь',
        description:
          'Гость - существующий (guestId) или новый (guest): по документу и телефону находится уже известный, дубль не создаётся. ' +
          'Двойная бронь номера на те же даты невозможна: 409 code=room.occupied с тем, что занимает номер. ' +
          'Передавайте Idempotency-Key: повтор запроса не создаст вторую бронь.',
        params: P,
        body: CreateBookingInput,
        response: { 201: BookingDto, 409: Problem },
      },
      config: { permission: 'booking.create', idempotent: true },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      const id = await svc.createBooking(deps, ctx, req.body);
      const dto = await svc.bookingDto(db, ctx, id);
      setEtag(reply, dto.version);
      return reply.status(201).send(dto);
    },
  );

  app.get(
    '/bookings/:id',
    { schema: { tags: ['Брони'], summary: 'Бронь', params: PI, response: { 200: BookingDto } }, config: { permission: 'booking.view' } },
    async (req, reply) => {
      const dto = await svc.bookingDto(db, ctxOf(req), req.params.id);
      setEtag(reply, dto.version);
      return dto;
    },
  );

  app.patch(
    '/bookings/:id',
    {
      schema: {
        tags: ['Брони'],
        summary: 'Изменить бронь: даты, номер, тариф, цену',
        description:
          'Перенос в другой номер, продление, ранний заезд и поздний выезд - с пересчётом цены. Нужен If-Match с версией брони: ' +
          'если бронь уже изменил другой сотрудник, ответ 412.',
        params: PI,
        body: UpdateBookingInput,
        response: { 200: BookingDto, 409: Problem, 412: Problem },
      },
      config: { permission: 'booking.edit' },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      const version = expectedVersion(req, req.body.version);
      await svc.updateBooking(deps, ctx, req.params.id, req.body, version);
      const dto = await svc.bookingDto(db, ctx, req.params.id);
      setEtag(reply, dto.version);
      return dto;
    },
  );

  app.post(
    '/bookings/:id/confirm',
    {
      schema: { tags: ['Брони'], summary: 'Подтвердить бронь', params: PI, body: z.object(VersionBody).default({}), response: { 200: BookingDto } },
      config: { permission: 'booking.confirm' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      await svc.confirmBooking(deps, ctx, req.params.id, optionalVersion(req.headers['if-match'], req.body.version));
      return svc.bookingDto(db, ctx, req.params.id);
    },
  );

  app.post(
    '/bookings/:id/cancel',
    {
      schema: {
        tags: ['Брони'],
        summary: 'Отменить бронь с причиной',
        params: PI,
        body: z.object({ reason: z.string().trim().min(1).max(500), ...VersionBody }),
        response: { 200: BookingDto },
      },
      config: { permission: 'booking.cancel' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      await svc.cancelBooking(deps, ctx, req.params.id, req.body.reason, optionalVersion(req.headers['if-match'], req.body.version));
      return svc.bookingDto(db, ctx, req.params.id);
    },
  );

  app.post(
    '/bookings/:id/no-show',
    {
      schema: {
        tags: ['Брони'],
        summary: 'Незаезд с причиной',
        params: PI,
        body: z.object({ reason: z.string().trim().min(1).max(500), ...VersionBody }),
        response: { 200: BookingDto },
      },
      config: { permission: 'booking.cancel' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      await svc.noShowBooking(deps, ctx, req.params.id, req.body.reason, optionalVersion(req.headers['if-match'], req.body.version));
      return svc.bookingDto(db, ctx, req.params.id);
    },
  );

  app.get(
    '/bookings/:id/check-in',
    {
      schema: {
        tags: ['Заселение'],
        summary: 'Готовность к заселению',
        description: 'Что мешает заселить: дата, состояние номера, данные гостя, согласие на обработку данных.',
        params: PI,
        response: { 200: ReadinessDto },
      },
      config: { permission: 'booking.checkin' },
    },
    async (req) => svc.checkInReadiness(deps, ctxOf(req), req.params.id),
  );

  app.post(
    '/bookings/:id/check-in',
    {
      schema: {
        tags: ['Заселение'],
        summary: 'Заселить',
        params: PI,
        body: z.object({ keyIssued: z.boolean().default(true), ...VersionBody }).default({ keyIssued: true }),
        response: { 200: BookingDto, 409: Problem },
      },
      config: { permission: 'booking.checkin' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      await svc.checkIn(deps, ctx, req.params.id, {
        keyIssued: req.body.keyIssued,
        version: optionalVersion(req.headers['if-match'], req.body.version),
      });
      return svc.bookingDto(db, ctx, req.params.id);
    },
  );

  app.post(
    '/bookings/:id/check-out',
    {
      schema: {
        tags: ['Заселение'],
        summary: 'Выселить',
        description:
          'Счёт должен быть сверен: проживание + начисления - оплаты = 0, депозит возвращён. Номер уходит в «грязный» и в задачу горничной.',
        params: PI,
        body: z
          .object({
            rating: z.number().int().min(1).max(5).nullable().optional(),
            feedback: z.string().trim().max(2000).nullable().optional(),
            allowDebt: z.boolean().default(false),
            debtReason: z.string().trim().max(500).nullable().optional(),
            ...VersionBody,
          })
          .default({ allowDebt: false }),
        response: { 200: BookingDto, 409: Problem },
      },
      config: { permission: 'booking.checkout' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      await svc.checkOut(deps, ctx, req.params.id, { ...req.body, version: optionalVersion(req.headers['if-match'], req.body.version) });
      return svc.bookingDto(db, ctx, req.params.id);
    },
  );

  // ── Блокировки ───────────────────────────────────────────────────────────
  app.post(
    '/room-blocks',
    {
      schema: {
        tags: ['Шахматка'],
        summary: 'Заблокировать номер на даты',
        params: P,
        body: z.object({ roomId: z.uuid(), startsOn: z.iso.date(), endsOn: z.iso.date(), reason: z.string().trim().min(1).max(300) }),
        response: { 201: RoomBlockDto, 409: Problem },
      },
      config: { permission: 'block.manage' },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      const id = await svc.createBlock(deps, ctx, req.body);
      return reply.status(201).send(await blockDto(id, ctx.propertyId));
    },
  );

  app.post(
    '/room-blocks/:id/release',
    {
      schema: {
        tags: ['Шахматка'],
        summary: 'Снять блокировку',
        params: PI,
        body: z.object({ note: z.string().trim().max(300).default('Снята вручную') }).default({ note: 'Снята вручную' }),
        response: { 200: RoomBlockDto },
      },
      config: { permission: 'block.manage' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      await db.transaction((tx) => svc.releaseBlock(tx, ctx, req.params.id, req.body.note));
      return blockDto(req.params.id, ctx.propertyId);
    },
  );

  async function blockDto(id: string, propertyId: string) {
    const [r] = await db
      .select({ k: roomBlocks, roomNumber: rooms.number })
      .from(roomBlocks)
      .innerJoin(rooms, eq(rooms.id, roomBlocks.roomId))
      .where(and(eq(roomBlocks.id, id), eq(roomBlocks.propertyId, propertyId)));
    if (!r) throw notFound('block.not_found', 'Блокировка не найдена');
    return {
      id: r.k.id,
      roomId: r.k.roomId,
      roomNumber: r.roomNumber,
      startsOn: r.k.startsOn,
      endsOn: r.k.endsOn,
      reason: r.k.reason,
      isActive: r.k.isActive,
      maintenanceRequestId: r.k.maintenanceRequestId,
    };
  }

  // ── Группы ───────────────────────────────────────────────────────────────
  app.post(
    '/booking-groups',
    {
      schema: {
        tags: ['Брони'],
        summary: 'Групповая бронь: несколько номеров на одну организацию',
        params: P,
        body: z.object({
          name: z.string().trim().min(1).max(200),
          companyId: z.uuid().nullable().optional(),
          billing: z.enum(['single', 'split']).default('split'),
          comment: z.string().trim().max(2000).nullable().optional(),
        }),
        response: { 201: GroupDto },
      },
      config: { permission: 'booking.create', idempotent: true },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      if (!req.body.name) throw badRequest('group.name_required', 'Назовите группу');
      const id = await svc.createGroup(deps, ctx, req.body);
      return reply.status(201).send(await svc.groupDto(db, ctx, id));
    },
  );

  app.get(
    '/booking-groups/:id',
    { schema: { tags: ['Брони'], summary: 'Групповая бронь', params: PI, response: { 200: GroupDto } }, config: { permission: 'booking.view' } },
    async (req) => svc.groupDto(db, ctxOf(req), req.params.id),
  );
};
