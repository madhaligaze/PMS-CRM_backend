import { and, asc, desc, eq, gte, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, emit } from '../../core/audit.ts';
import { can, type PropertyContext } from '../../core/context.ts';
import { ctxOf } from '../../core/guards.ts';
import type { DbOrTx } from '../../db/client.ts';
import { attendanceEvents, memberships, positions, properties, users } from '../../db/schema/index.ts';
import { ACCESS_LABELS, type Access } from '../../lib/access.ts';
import { verifySecret } from '../../lib/crypto.ts';
import { toCsv } from '../../lib/csv.ts';
import { addDays, localDate, monthRange, zonedToUtc } from '../../lib/dates.ts';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';

const P = z.object({ propertyId: z.uuid() });
const PI = P.extend({ id: z.uuid() });
const Kind = z.enum(['in', 'out']).meta({ id: 'AttendanceKind' });

export const AttendanceEventDto = z
  .object({
    id: z.uuid(),
    userId: z.uuid(),
    userName: z.string(),
    kind: Kind,
    at: z.iso.datetime(),
    method: z.enum(['pin', 'self', 'manual']),
    device: z.string().nullable(),
    correctsId: z.uuid().nullable(),
    supersededBy: z.uuid().nullable(),
    reason: z.string().nullable(),
    createdBy: z.string().nullable(),
  })
  .meta({ id: 'AttendanceEvent' });

const MyStatusDto = z
  .object({ clockedIn: z.boolean(), since: z.iso.datetime().nullable(), lastEvent: AttendanceEventDto.nullable() })
  .meta({ id: 'AttendanceStatus' });

const TimesheetDto = z
  .object({
    month: z.string(),
    from: z.iso.date(),
    to: z.iso.date(),
    rows: z.array(
      z.object({
        userId: z.uuid(),
        name: z.string(),
        position: z.string(),
        totalMinutes: z.number().int(),
        daysWorked: z.number().int(),
        missingOut: z.number().int().describe('Сколько раз не отмечен уход'),
        days: z.array(
          z.object({
            date: z.iso.date(),
            firstIn: z.iso.datetime().nullable(),
            lastOut: z.iso.datetime().nullable(),
            minutes: z.number().int(),
            open: z.boolean().describe('Приход без ухода: отметку ухода пропустили'),
            working: z.boolean().describe('Приход без ухода, но человек ещё на работе'),
          }),
        ),
      }),
    ),
  })
  .meta({ id: 'Timesheet' });

async function eventDtos(tx: DbOrTx, conds: SQL[], order: 'asc' | 'desc' = 'desc', limit = 1000) {
  const creator = sql<string | null>`(select full_name from users u2 where u2.id = ${attendanceEvents.createdBy})`;
  const rows = await tx
    .select({ e: attendanceEvents, userName: users.fullName, createdBy: creator })
    .from(attendanceEvents)
    .innerJoin(users, eq(users.id, attendanceEvents.userId))
    .where(and(...conds))
    .orderBy(order === 'asc' ? asc(attendanceEvents.at) : desc(attendanceEvents.at))
    .limit(limit);
  return rows.map((r) => ({
    id: r.e.id,
    userId: r.e.userId,
    userName: r.userName,
    kind: r.e.kind,
    at: r.e.at.toISOString(),
    method: r.e.method,
    device: r.e.device,
    correctsId: r.e.correctsId,
    supersededBy: r.e.supersededBy,
    reason: r.e.reason,
    createdBy: r.createdBy,
  }));
}

async function lastEvent(tx: DbOrTx, propertyId: string, userId: string) {
  const [e] = await eventDtos(tx, [eq(attendanceEvents.propertyId, propertyId), eq(attendanceEvents.userId, userId), isNull(attendanceEvents.supersededBy)], 'desc', 1);
  return e ?? null;
}

async function status(tx: DbOrTx, propertyId: string, userId: string) {
  const last = await lastEvent(tx, propertyId, userId);
  const clockedIn = !!last && last.kind === 'in' && Date.now() - new Date(last.at).getTime() < 26 * 3_600_000;
  return { clockedIn, since: clockedIn ? last!.at : null, lastEvent: last };
}

async function clock(
  tx: DbOrTx,
  ctx: Pick<PropertyContext, 'propertyId' | 'orgId' | 'requestId' | 'ip'> & { actor: { id: string; name: string } },
  userId: string,
  method: 'pin' | 'self',
  kind: 'in' | 'out' | undefined,
  device: string | null,
) {
  const st = await status(tx, ctx.propertyId, userId);
  const next = kind ?? (st.clockedIn ? 'out' : 'in');
  if (next === 'in' && st.clockedIn) throw conflict('attendance.already_in', 'Приход уже отмечен');
  if (next === 'out' && !st.clockedIn) throw conflict('attendance.not_in', 'Сначала нужна отметка прихода');
  const id = newId();
  await tx.insert(attendanceEvents).values({ id, propertyId: ctx.propertyId, userId, kind: next, at: new Date(), method, device, createdBy: ctx.actor.id });
  await audit(tx, { ...ctx, propertyId: ctx.propertyId }, {
    action: `attendance.${next}`,
    entityType: 'user',
    entityId: userId,
    entityLabel: ctx.actor.name,
    changes: { [next === 'in' ? 'Приход' : 'Уход']: [null, method === 'pin' ? 'PIN на планшете' : 'со своего устройства'] },
  });
  await emit(tx, ctx, 'attendance.changed', userId);
  return next;
}

type SheetDay = { firstIn: Date | null; lastOut: Date | null; minutes: number; open: boolean; working: boolean };

/**
 * Пары «приход - уход» по сотруднику: день относится к дате прихода по времени
 * гостиницы. Приход без ухода - пропущенная отметка, кроме последнего прихода
 * моложе суток: человек ещё на работе, это не ошибка.
 */
function timesheetRows(events: { userId: string; kind: 'in' | 'out'; at: Date }[], tz: string, from: string, to: string, now = new Date()) {
  const byUser = new Map<string, typeof events>();
  for (const e of events) byUser.set(e.userId, [...(byUser.get(e.userId) ?? []), e]);
  const out = new Map<string, { totalMinutes: number; missingOut: number; days: Map<string, SheetDay> }>();
  for (const [userId, list] of byUser) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime());
    const acc = { totalMinutes: 0, missingOut: 0, days: new Map<string, SheetDay>() };
    let openIn: Date | null = null;
    const close = (end: Date | null, last = false) => {
      if (!openIn) return;
      const date = localDate(openIn, tz);
      if (date >= from && date <= to) {
        const day = acc.days.get(date) ?? { firstIn: null, lastOut: null, minutes: 0, open: false, working: false };
        if (!day.firstIn || openIn < day.firstIn) day.firstIn = openIn;
        if (end) {
          const minutes = Math.max(0, Math.round((end.getTime() - openIn.getTime()) / 60_000));
          day.minutes += minutes;
          acc.totalMinutes += minutes;
          if (!day.lastOut || end > day.lastOut) day.lastOut = end;
        } else if (last && now.getTime() - openIn.getTime() < 26 * 3_600_000) {
          day.working = true;
        } else {
          day.open = true;
          acc.missingOut += 1;
        }
        acc.days.set(date, day);
      }
      openIn = null;
    };
    for (const e of list) {
      if (e.kind === 'in') {
        if (openIn) close(null);
        openIn = e.at;
      } else if (openIn) {
        close(e.at);
      }
    }
    if (openIn) close(null, true);
    out.set(userId, acc);
  }
  return out;
}

export const attendanceRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = app.deps.db;

  app.get(
    '/attendance/me',
    { schema: { tags: ['Учёт времени'], summary: 'Отмечен ли мой приход', params: P, response: { 200: MyStatusDto } }, config: { permission: 'attendance.self' } },
    async (req) => {
      const ctx = ctxOf(req);
      return status(db, ctx.propertyId, ctx.actor.id!);
    },
  );

  app.post(
    '/attendance/clock',
    {
      schema: {
        tags: ['Учёт времени'],
        summary: 'Отметить приход или уход со своего устройства',
        description: 'Без kind - переключение: был приход, будет уход.',
        params: P,
        body: z.object({ kind: Kind.optional() }).default({}),
        response: { 200: MyStatusDto },
      },
      config: { permission: 'attendance.self', rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const ua = req.headers['user-agent'];
      await db.transaction((tx) =>
        clock(tx, { ...ctx, actor: { id: ctx.actor.id!, name: ctx.actor.name } }, ctx.actor.id!, 'self', req.body.kind, typeof ua === 'string' ? ua.slice(0, 120) : null),
      );
      return status(db, ctx.propertyId, ctx.actor.id!);
    },
  );

  app.get(
    '/attendance',
    {
      schema: {
        tags: ['Учёт времени'],
        summary: 'Отметки за период',
        params: P,
        querystring: z.object({ from: z.iso.date().optional(), to: z.iso.date().optional(), userId: z.uuid().optional() }),
        response: { 200: z.array(AttendanceEventDto) },
      },
      config: { permission: ['attendance.view', 'attendance.self'] },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const tz = ctx.property.timezone;
      const to = req.query.to ?? localDate(new Date(), tz);
      const from = req.query.from ?? addDays(to, -6);
      const conds: SQL[] = [
        eq(attendanceEvents.propertyId, ctx.propertyId),
        gte(attendanceEvents.at, zonedToUtc(from, '00:00', tz)),
        lte(attendanceEvents.at, zonedToUtc(addDays(to, 1), '00:00', tz)),
      ];
      if (!can(ctx, 'attendance.view')) conds.push(eq(attendanceEvents.userId, ctx.actor.id!));
      else if (req.query.userId) conds.push(eq(attendanceEvents.userId, req.query.userId));
      return eventDtos(db, conds);
    },
  );

  app.post(
    '/attendance/:id/correct',
    {
      schema: {
        tags: ['Учёт времени'],
        summary: 'Исправить отметку (только управляющий, с причиной)',
        params: PI,
        body: z.object({ at: z.iso.datetime({ offset: true }), kind: Kind.optional(), reason: z.string().trim().min(1).max(300) }),
        response: { 200: AttendanceEventDto },
      },
      config: { permission: 'attendance.correct' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const id = await db.transaction(async (tx) => {
        const [orig] = await tx
          .select()
          .from(attendanceEvents)
          .where(and(eq(attendanceEvents.id, req.params.id), eq(attendanceEvents.propertyId, ctx.propertyId)))
          .for('update');
        if (!orig) throw notFound('attendance.not_found', 'Отметка не найдена');
        if (orig.supersededBy) throw conflict('attendance.superseded', 'Эта отметка уже исправлена');
        const nid = newId();
        await tx.insert(attendanceEvents).values({
          id: nid,
          propertyId: ctx.propertyId,
          userId: orig.userId,
          kind: req.body.kind ?? orig.kind,
          at: new Date(req.body.at),
          method: 'manual',
          correctsId: orig.id,
          reason: req.body.reason,
          createdBy: ctx.actor.id,
        });
        await tx.update(attendanceEvents).set({ supersededBy: nid }).where(eq(attendanceEvents.id, orig.id));
        const [u] = await tx.select({ name: users.fullName }).from(users).where(eq(users.id, orig.userId));
        await audit(tx, ctx, {
          action: 'attendance.correct',
          entityType: 'user',
          entityId: orig.userId,
          entityLabel: u?.name,
          changes: { at: [orig.at.toISOString(), req.body.at], kind: [orig.kind, req.body.kind ?? orig.kind] },
          reason: req.body.reason,
        });
        return nid;
      });
      const [dto] = await eventDtos(db, [eq(attendanceEvents.id, id)]);
      return dto!;
    },
  );

  app.post(
    '/attendance/manual',
    {
      schema: {
        tags: ['Учёт времени'],
        summary: 'Добавить пропущенную отметку (только управляющий, с причиной)',
        params: P,
        body: z.object({ userId: z.uuid(), kind: Kind, at: z.iso.datetime({ offset: true }), reason: z.string().trim().min(1).max(300) }),
        response: { 201: AttendanceEventDto },
      },
      config: { permission: 'attendance.correct' },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      const id = newId();
      await db.transaction(async (tx) => {
        const [m] = await tx.select().from(memberships).where(and(eq(memberships.userId, req.body.userId), eq(memberships.propertyId, ctx.propertyId)));
        if (!m) throw notFound('user.not_found', 'Сотрудник не найден');
        await tx.insert(attendanceEvents).values({
          id,
          propertyId: ctx.propertyId,
          userId: req.body.userId,
          kind: req.body.kind,
          at: new Date(req.body.at),
          method: 'manual',
          reason: req.body.reason,
          createdBy: ctx.actor.id,
        });
        const [u] = await tx.select({ name: users.fullName }).from(users).where(eq(users.id, req.body.userId));
        await audit(tx, ctx, {
          action: 'attendance.manual',
          entityType: 'user',
          entityId: req.body.userId,
          entityLabel: u?.name,
          changes: { [req.body.kind === 'in' ? 'Приход' : 'Уход']: [null, req.body.at] },
          reason: req.body.reason,
        });
      });
      const [dto] = await eventDtos(db, [eq(attendanceEvents.id, id)]);
      return reply.status(201).send(dto!);
    },
  );

  async function timesheet(ctx: PropertyContext, month: string) {
    const tz = ctx.property.timezone;
    const { from, to } = monthRange(month);
    const staff = await db
      .select({ id: users.id, name: users.fullName, access: memberships.access, position: positions.name, archivedAt: users.archivedAt })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(positions, eq(positions.id, memberships.positionId))
      .where(eq(memberships.propertyId, ctx.propertyId))
      .orderBy(asc(users.fullName));
    const events = await db
      .select({ userId: attendanceEvents.userId, kind: attendanceEvents.kind, at: attendanceEvents.at })
      .from(attendanceEvents)
      .where(
        and(
          eq(attendanceEvents.propertyId, ctx.propertyId),
          isNull(attendanceEvents.supersededBy),
          gte(attendanceEvents.at, zonedToUtc(addDays(from, -1), '00:00', tz)),
          lte(attendanceEvents.at, zonedToUtc(addDays(to, 2), '00:00', tz)),
        ),
      );
    const sheet = timesheetRows(events, tz, from, to);
    // Уволенный в табеле остаётся за те месяцы, в которых работал.
    const rows = staff.filter((s) => !s.archivedAt || sheet.has(s.id)).map((s) => {
      const acc = sheet.get(s.id);
      const days = acc
        ? [...acc.days.entries()]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([date, d]) => ({ date, firstIn: d.firstIn?.toISOString() ?? null, lastOut: d.lastOut?.toISOString() ?? null, minutes: d.minutes, open: d.open, working: d.working }))
        : [];
      return {
        userId: s.id,
        name: s.name,
        position: s.position ?? ACCESS_LABELS[s.access as Access],
        totalMinutes: acc?.totalMinutes ?? 0,
        daysWorked: days.length,
        missingOut: acc?.missingOut ?? 0,
        days,
      };
    });
    return { month, from, to, rows };
  }

  const Month = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, 'Месяц в формате ГГГГ-ММ') });

  app.get(
    '/attendance/timesheet',
    {
      schema: {
        tags: ['Учёт времени'],
        summary: 'Табель за месяц: для расчёта зарплаты',
        params: P,
        querystring: Month,
        response: { 200: TimesheetDto },
      },
      config: { permission: 'attendance.view' },
    },
    async (req) => timesheet(ctxOf(req), req.query.month),
  );

  app.get(
    '/attendance/timesheet/export',
    {
      schema: { tags: ['Учёт времени'], summary: 'Табель за месяц в CSV (Excel, 1С)', params: P, querystring: Month },
      config: { permission: 'attendance.view' },
    },
    async (req, reply) => {
      const sheet = await timesheet(ctxOf(req), req.query.month);
      const header = ['Сотрудник', 'Должность', 'Дней', 'Часов', 'Без отметки ухода'];
      const lines = sheet.rows.map((r) => [r.name, r.position, r.daysWorked, (r.totalMinutes / 60).toFixed(2).replace('.', ','), r.missingOut]);
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="timesheet-${req.query.month}.csv"`)
        .send(toCsv([header, ...lines]));
    },
  );
};

/**
 * Общий планшет на ресепшене: сотрудник вводит логин и PIN. Отдельного входа
 * в систему для этого не нужно. Ответ не раскрывает, что именно неверно.
 */
export const kioskRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = app.deps.db;
  app.post(
    '/kiosk/clock',
    {
      schema: {
        tags: ['Учёт времени'],
        summary: 'Отметка прихода или ухода по PIN на общем планшете',
        security: [],
        body: z.object({ propertyId: z.uuid(), login: z.string().min(1).max(100), pin: z.string().regex(/^\d{4,6}$/) }),
        response: { 200: z.object({ name: z.string(), kind: Kind, at: z.iso.datetime() }) },
      },
      config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
    },
    async (req) => {
      const [u] = await db
        .select({ user: users, property: properties })
        .from(users)
        .innerJoin(memberships, eq(memberships.userId, users.id))
        .innerJoin(properties, eq(properties.id, memberships.propertyId))
        .where(and(sql`lower(${users.login}) = lower(${req.body.login.trim()})`, eq(memberships.propertyId, req.body.propertyId)))
        .limit(1);
      // Отметиться может каждый работающий сотрудник: уволенный и заблокированный - нет.
      if (!u || !u.user.pinHash || !u.user.isActive || u.user.archivedAt || !(await verifySecret(req.body.pin, u.user.pinHash))) {
        throw unauthorized('kiosk.invalid', 'Неверный логин или PIN');
      }
      const ctx = { orgId: u.property.orgId, propertyId: u.property.id, requestId: String(req.id), ip: req.ip ?? null, actor: { id: u.user.id, name: u.user.fullName } };
      const kind = await db.transaction((tx) => clock(tx, ctx, u.user.id, 'pin', undefined, 'kiosk'));
      if (!kind) throw badRequest('kiosk.failed', 'Не удалось отметиться');
      return { name: u.user.fullName, kind, at: new Date().toISOString() };
    },
  );
};
