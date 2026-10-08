import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { PropertyContext } from '../../core/context.ts';
import { ctxOf } from '../../core/guards.ts';
import type { DbOrTx } from '../../db/client.ts';
import { csvMoney, toCsv } from '../../lib/csv.ts';
import { addDays, diffDays, eachNight } from '../../lib/dates.ts';
import { badRequest } from '../../lib/errors.ts';
import { today } from '../bookings/service.ts';
import { METHOD_LABEL } from '../cash/service.ts';

const P = z.object({ propertyId: z.uuid() });

const SOURCE_LABEL: Record<string, string> = {
  phone: 'Телефон / колл-центр',
  walk_in: 'Ресепшен, с улицы',
  website: 'Сайт',
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  booking_com: 'Booking.com',
  ota_other: 'Другие OTA',
  email: 'Почта',
  other: 'Другое',
};

const Line = z.object({ key: z.string(), label: z.string(), amount: z.number().int(), count: z.number().int() });
const EventRow = z.object({
  bookingId: z.uuid().nullable(),
  bookingNumber: z.number().int().nullable(),
  guest: z.string().nullable(),
  kind: z.string(),
  amount: z.number().int(),
  reason: z.string().nullable(),
  by: z.string().nullable(),
  at: z.iso.datetime(),
});

const DailyDto = z
  .object({
    date: z.iso.date(),
    rooms: z.object({ total: z.number().int(), available: z.number().int(), occupied: z.number().int(), occupancyPct: z.number() }),
    arrivals: z.object({ expected: z.number().int(), arrived: z.number().int() }),
    departures: z.object({ expected: z.number().int(), departed: z.number().int() }),
    inHouse: z.number().int(),
    guests: z.number().int(),
    revenue: z.object({ accommodation: z.number().int(), payments: z.number().int(), refunds: z.number().int(), byMethod: z.array(Line) }),
    cancellations: z.array(EventRow),
    discounts: z.array(EventRow),
    stornos: z.array(EventRow),
  })
  .meta({ id: 'DailyReport' });

const PeriodDayDto = z.object({
  date: z.iso.date(),
  available: z.number().int(),
  occupied: z.number().int(),
  tentative: z.number().int(),
  occupancyPct: z.number(),
  revenue: z.number().int(),
  adr: z.number().int(),
  revpar: z.number().int(),
});

const PeriodDto = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    days: z.array(PeriodDayDto),
    totals: PeriodDayDto.omit({ date: true }),
    bySource: z.array(z.object({ key: z.string(), label: z.string(), bookings: z.number().int(), nights: z.number().int(), revenue: z.number().int() })),
    byStaff: z.array(
      z.object({ userId: z.uuid(), name: z.string(), bookings: z.number().int(), nights: z.number().int(), revenue: z.number().int(), stornos: z.number().int(), stornoAmount: z.number().int() }),
    ),
    housekeeping: z.object({
      tasksDone: z.number().int(),
      avgCleanMinutes: z.number().int().nullable(),
      overdue: z.number().int(),
      openRequests: z.number().int(),
      blockedRoomNights: z.number().int(),
    }),
  })
  .meta({ id: 'PeriodReport' });

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);

async function availability(db: DbOrTx, ctx: PropertyContext, from: string, to: string) {
  const [rooms] = await db.execute<{ n: string }>(sql`select count(*) as n from rooms where property_id = ${ctx.propertyId} and is_active`);
  const total = Number(rooms?.n ?? 0);
  const blocks = await db.execute<{ starts_on: string; ends_on: string }>(sql`
    select starts_on::text, ends_on::text from room_blocks
    where property_id = ${ctx.propertyId} and is_active and starts_on <= ${to} and ends_on > ${from}
  `);
  return { total, blockedOn: (d: string) => blocks.filter((b) => b.starts_on <= d && b.ends_on > d).length };
}

async function nightStats(db: DbOrTx, ctx: PropertyContext, from: string, to: string) {
  const rows = await db.execute<{ date: string; sold: string; tentative: string; revenue: string }>(sql`
    select n.date::text as date,
      count(*) filter (where b.status in ('confirmed','checked_in','checked_out')) as sold,
      count(*) filter (where b.status = 'tentative') as tentative,
      coalesce(sum(n.amount) filter (where b.status in ('confirmed','checked_in','checked_out')), 0) as revenue
    from bookings b
    cross join lateral jsonb_to_recordset(b.nights) as n(date date, base bigint, amount bigint)
    where b.property_id = ${ctx.propertyId} and n.date between ${from}::date and ${to}::date
    group by n.date
  `);
  return new Map(rows.map((r) => [r.date, { sold: Number(r.sold), tentative: Number(r.tentative), revenue: Number(r.revenue) }]));
}

export const reportRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = app.deps.db;

  app.get(
    '/reports/daily',
    {
      schema: {
        tags: ['Отчёты'],
        summary: 'Ежедневный отчёт: загрузка, заезды и выезды, выручка по способам оплаты, отмены и скидки',
        params: P,
        querystring: z.object({ date: z.iso.date().optional() }),
        response: { 200: DailyDto },
      },
      config: { permission: 'reports.view' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const tz = ctx.property.timezone;
      const date = req.query.date ?? today(ctx);
      const av = await availability(db, ctx, date, date);
      const nights = (await nightStats(db, ctx, date, date)).get(date) ?? { sold: 0, tentative: 0, revenue: 0 };
      const available = Math.max(0, av.total - av.blockedOn(date));

      const [mv] = await db.execute<{ arr_exp: string; arr_done: string; dep_exp: string; dep_done: string; inhouse: string; guests: string }>(sql`
        select
          count(*) filter (where arrival = ${date} and status in ('tentative','confirmed','checked_in','checked_out','no_show')) as arr_exp,
          count(*) filter (where arrival = ${date} and status in ('checked_in','checked_out')) as arr_done,
          count(*) filter (where departure = ${date} and status in ('checked_in','checked_out')) as dep_exp,
          count(*) filter (where departure = ${date} and status = 'checked_out') as dep_done,
          count(*) filter (where status = 'checked_in' and arrival <= ${date} and departure > ${date}) as inhouse,
          coalesce(sum(adults + children) filter (where status = 'checked_in' and arrival <= ${date} and departure > ${date}), 0) as guests
        from bookings where property_id = ${ctx.propertyId}
      `);

      const pays = await db.execute<{ method: string; kind: string; storno: boolean; amount: string; n: string }>(sql`
        select method, kind, storno_of is not null as storno, sum(amount) as amount, count(*) as n
        from payments
        where property_id = ${ctx.propertyId} and (created_at at time zone ${tz})::date = ${date}::date
        group by method, kind, storno_of is not null
      `);
      const sign = (kind: string, storno: boolean) => ((kind === 'payment' || kind === 'deposit' ? 1 : -1) * (storno ? -1 : 1));
      const byMethod = (Object.keys(METHOD_LABEL) as (keyof typeof METHOD_LABEL)[]).map((m) => {
        const rows = pays.filter((p) => p.method === m && (p.kind === 'payment' || p.kind === 'deposit') && !p.storno);
        return { key: m, label: METHOD_LABEL[m], amount: rows.reduce((a, r) => a + Number(r.amount), 0), count: rows.reduce((a, r) => a + Number(r.n), 0) };
      });
      const net = pays.filter((p) => p.kind === 'payment' || p.kind === 'refund').reduce((a, p) => a + sign(p.kind, p.storno) * Number(p.amount), 0);
      const refunds = pays.filter((p) => p.kind === 'refund' && !p.storno).reduce((a, p) => a + Number(p.amount), 0);

      const cancels = await db.execute<{ id: string; number: number; guest: string; status: string; reason: string | null; by: string | null; at: Date; total: string }>(sql`
        select b.id, b.number, g.last_name || ' ' || g.first_name as guest, b.status, b.cancel_reason as reason, u.full_name as by, b.cancelled_at as at,
          b.accommodation_total as total
        from bookings b join guests g on g.id = b.guest_id left join users u on u.id = b.cancelled_by
        where b.property_id = ${ctx.propertyId} and b.status in ('cancelled','no_show')
          and (b.cancelled_at at time zone ${tz})::date = ${date}::date
        order by b.cancelled_at
      `);
      const discounts = await db.execute<{ id: string; number: number; guest: string; mode: string; reason: string | null; by: string | null; at: Date; discount: string }>(sql`
        select b.id, b.number, g.last_name || ' ' || g.first_name as guest, b.price_mode as mode, b.price_reason as reason,
          u.full_name as by, b.created_at as at, b.base_total - b.accommodation_total as discount
        from bookings b join guests g on g.id = b.guest_id left join users u on u.id = b.created_by
        where b.property_id = ${ctx.propertyId} and b.price_mode <> 'rate'
          and (b.created_at at time zone ${tz})::date = ${date}::date
        order by b.created_at
      `);
      const stornos = await db.execute<{ id: string | null; number: number | null; guest: string | null; kind: string; amount: string; reason: string | null; by: string | null; at: Date }>(sql`
        select b.id, b.number, g.last_name || ' ' || g.first_name as guest, 'Сторно оплаты ' || o.number as kind, p.amount, p.storno_reason as reason, u.full_name as by, p.created_at as at
        from payments p
        join payments o on o.id = p.storno_of
        left join bookings b on b.id = p.booking_id left join guests g on g.id = b.guest_id
        left join users u on u.id = p.created_by
        where p.property_id = ${ctx.propertyId} and p.storno_of is not null and (p.created_at at time zone ${tz})::date = ${date}::date
        union all
        select b.id, b.number, g.last_name || ' ' || g.first_name, 'Сторно начисления: ' || o.description, -f.amount, f.storno_reason, u.full_name, f.created_at
        from folio_items f
        join folio_items o on o.id = f.storno_of
        join bookings b on b.id = f.booking_id join guests g on g.id = b.guest_id
        left join users u on u.id = f.created_by
        where f.property_id = ${ctx.propertyId} and f.storno_of is not null and (f.created_at at time zone ${tz})::date = ${date}::date
        order by at
      `);

      const at = (d: Date | string) => new Date(d).toISOString();
      return {
        date,
        rooms: { total: av.total, available, occupied: nights.sold, occupancyPct: pct(nights.sold, available) },
        arrivals: { expected: Number(mv?.arr_exp ?? 0), arrived: Number(mv?.arr_done ?? 0) },
        departures: { expected: Number(mv?.dep_exp ?? 0), departed: Number(mv?.dep_done ?? 0) },
        inHouse: Number(mv?.inhouse ?? 0),
        guests: Number(mv?.guests ?? 0),
        revenue: { accommodation: nights.revenue, payments: net, refunds, byMethod },
        cancellations: cancels.map((c) => ({
          bookingId: c.id,
          bookingNumber: c.number,
          guest: c.guest,
          kind: c.status === 'no_show' ? 'Незаезд' : 'Отмена',
          amount: Number(c.total),
          reason: c.reason,
          by: c.by,
          at: at(c.at),
        })),
        discounts: discounts.map((d) => ({
          bookingId: d.id,
          bookingNumber: d.number,
          guest: d.guest,
          kind: d.mode === 'special' ? 'Спеццена' : 'Скидка',
          amount: Number(d.discount),
          reason: d.reason,
          by: d.by,
          at: at(d.at),
        })),
        stornos: stornos.map((s) => ({ bookingId: s.id, bookingNumber: s.number, guest: s.guest, kind: s.kind, amount: Number(s.amount), reason: s.reason, by: s.by, at: at(s.at) })),
      };
    },
  );

  app.get(
    '/reports/period',
    {
      schema: {
        tags: ['Отчёты'],
        summary: 'Отчёт за период: загрузка, ADR, RevPAR, источники, сотрудники, хозслужба',
        params: P,
        querystring: z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }),
        response: { 200: PeriodDto },
      },
      config: { permission: 'reports.view' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const to = req.query.to ?? today(ctx);
      const from = req.query.from ?? addDays(to, -29);
      if (diffDays(from, to) < 0 || diffDays(from, to) > 400) throw badRequest('report.range', 'Период отчёта - до 400 дней');
      const av = await availability(db, ctx, from, addDays(to, 1));
      const stats = await nightStats(db, ctx, from, to);
      const days = eachNight(from, addDays(to, 1)).map((date) => {
        const s = stats.get(date) ?? { sold: 0, tentative: 0, revenue: 0 };
        const available = Math.max(0, av.total - av.blockedOn(date));
        return {
          date,
          available,
          occupied: s.sold,
          tentative: s.tentative,
          occupancyPct: pct(s.sold, available),
          revenue: s.revenue,
          adr: s.sold ? Math.round(s.revenue / s.sold) : 0,
          revpar: available ? Math.round(s.revenue / available) : 0,
        };
      });
      const sumOf = (k: 'available' | 'occupied' | 'tentative' | 'revenue') => days.reduce((a, d) => a + d[k], 0);
      const totals = {
        available: sumOf('available'),
        occupied: sumOf('occupied'),
        tentative: sumOf('tentative'),
        revenue: sumOf('revenue'),
        occupancyPct: pct(sumOf('occupied'), sumOf('available')),
        adr: sumOf('occupied') ? Math.round(sumOf('revenue') / sumOf('occupied')) : 0,
        revpar: sumOf('available') ? Math.round(sumOf('revenue') / sumOf('available')) : 0,
      };

      const sources = await db.execute<{ source: string; bookings: string; nights: string; revenue: string }>(sql`
        select b.source, count(distinct b.id) as bookings, count(n.date) as nights, coalesce(sum(n.amount), 0) as revenue
        from bookings b
        cross join lateral jsonb_to_recordset(b.nights) as n(date date, base bigint, amount bigint)
        where b.property_id = ${ctx.propertyId} and b.status in ('confirmed','checked_in','checked_out')
          and n.date between ${from}::date and ${to}::date
        group by b.source order by revenue desc
      `);
      const staff = await db.execute<{ user_id: string; name: string; bookings: string; nights: string; revenue: string; stornos: string; storno_amount: string }>(sql`
        with sold as (
          select b.created_by as user_id, count(distinct b.id) as bookings, count(n.date) as nights, coalesce(sum(n.amount), 0) as revenue
          from bookings b
          cross join lateral jsonb_to_recordset(b.nights) as n(date date, base bigint, amount bigint)
          where b.property_id = ${ctx.propertyId} and b.status in ('confirmed','checked_in','checked_out')
            and n.date between ${from}::date and ${to}::date and b.created_by is not null
          group by b.created_by
        ), st as (
          select created_by as user_id, count(*) as stornos, sum(amount) as storno_amount
          from payments
          where property_id = ${ctx.propertyId} and storno_of is not null
            and (created_at at time zone ${ctx.property.timezone})::date between ${from}::date and ${to}::date
          group by created_by
        )
        select u.id as user_id, u.full_name as name,
          coalesce(sold.bookings, 0) as bookings, coalesce(sold.nights, 0) as nights, coalesce(sold.revenue, 0) as revenue,
          coalesce(st.stornos, 0) as stornos, coalesce(st.storno_amount, 0) as storno_amount
        from users u
        left join sold on sold.user_id = u.id
        left join st on st.user_id = u.id
        where sold.user_id is not null or st.user_id is not null
        order by revenue desc
      `);
      const [hk] = await db.execute<{ done: string; avg_min: string | null; overdue: string; open_req: string }>(sql`
        select
          count(*) filter (where status in ('done','inspected')) as done,
          round(avg(extract(epoch from finished_at - started_at) / 60) filter (where status in ('done','inspected') and started_at is not null and finished_at is not null)) as avg_min,
          count(*) filter (where due_at is not null and (finished_at > due_at or (finished_at is null and due_at < now() and status in ('open','in_progress')))) as overdue,
          (select count(*) from maintenance_requests m where m.property_id = ${ctx.propertyId} and m.status in ('open','in_progress')) as open_req
        from hk_tasks
        where property_id = ${ctx.propertyId} and business_date between ${from}::date and ${to}::date
      `);
      const blockedNights = eachNight(from, addDays(to, 1)).reduce((a, d) => a + av.blockedOn(d), 0);

      return {
        from,
        to,
        days,
        totals,
        bySource: sources.map((s) => ({
          key: s.source,
          label: SOURCE_LABEL[s.source] ?? s.source,
          bookings: Number(s.bookings),
          nights: Number(s.nights),
          revenue: Number(s.revenue),
        })),
        byStaff: staff.map((s) => ({
          userId: s.user_id,
          name: s.name,
          bookings: Number(s.bookings),
          nights: Number(s.nights),
          revenue: Number(s.revenue),
          stornos: Number(s.stornos),
          stornoAmount: Number(s.storno_amount),
        })),
        housekeeping: {
          tasksDone: Number(hk?.done ?? 0),
          avgCleanMinutes: hk?.avg_min != null ? Number(hk.avg_min) : null,
          overdue: Number(hk?.overdue ?? 0),
          openRequests: Number(hk?.open_req ?? 0),
          blockedRoomNights: blockedNights,
        },
      };
    },
  );

  app.get(
    '/reports/payments-export',
    {
      schema: {
        tags: ['Отчёты'],
        summary: 'Выгрузка оплат за период в CSV (для 1С и Excel)',
        params: P,
        querystring: z.object({ from: z.iso.date(), to: z.iso.date() }),
      },
      config: { permission: 'reports.export' },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      const tz = ctx.property.timezone;
      const rows = await db.execute<{
        number: number; created_at: Date; shift: number; booking: number | null; guest: string | null; company: string | null;
        kind: string; method: string; payment_type: string; amount: string; storno_of: string | null; storno_reason: string | null;
        fiscal_number: string | null; by: string;
      }>(sql`
        select p.number, p.created_at, s.number as shift, b.number as booking, g.last_name || ' ' || g.first_name as guest, c.name as company,
          p.kind, p.method, p.payment_type, p.amount, o.number::text as storno_of, p.storno_reason, p.fiscal_number, u.full_name as by
        from payments p
        join cash_shifts s on s.id = p.shift_id
        join users u on u.id = p.created_by
        left join bookings b on b.id = p.booking_id
        left join guests g on g.id = b.guest_id
        left join companies c on c.id = p.company_id
        left join payments o on o.id = p.storno_of
        where p.property_id = ${ctx.propertyId}
          and (p.created_at at time zone ${tz})::date between ${req.query.from}::date and ${req.query.to}::date
        order by p.number
      `);
      const kindLabel: Record<string, string> = { payment: 'Оплата', refund: 'Возврат', deposit: 'Депозит', deposit_return: 'Возврат депозита' };
      const typeLabel: Record<string, string> = { cash: 'Наличные', cashless: 'Безналичные', special: 'Спеццена' };
      const fmt = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' });
      const header = ['№', 'Дата', 'Смена', 'Бронь', 'Гость', 'Компания', 'Операция', 'Способ', 'Тип оплаты', 'Сумма', 'Сторно документа', 'Причина сторно', 'Чек', 'Кассир'];
      const lines = rows.map((r) => [
        r.number,
        fmt.format(new Date(r.created_at)),
        r.shift,
        r.booking ?? '',
        r.guest ?? '',
        r.company ?? '',
        kindLabel[r.kind] ?? r.kind,
        METHOD_LABEL[r.method as keyof typeof METHOD_LABEL] ?? r.method,
        typeLabel[r.payment_type] ?? r.payment_type,
        csvMoney(Number(r.amount)),
        r.storno_of ?? '',
        r.storno_reason ?? '',
        r.fiscal_number ?? '',
        r.by,
      ]);
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="payments-${req.query.from}-${req.query.to}.csv"`)
        .send(toCsv([header, ...lines]));
    },
  );
};
