import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { can } from '../../core/context.ts';
import { ctxOf } from '../../core/guards.ts';
import { hkTasks, maintenanceRequests, rooms } from '../../db/schema/index.ts';
import { BookingListItemDto } from '../bookings/schemas.ts';
import { listBookings, today } from '../bookings/service.ts';
import { buildReport, isClockedIn, openShift } from '../cash/service.ts';

const P = z.object({ propertyId: z.uuid() });

const DashboardDto = z
  .object({
    businessDate: z.iso.date(),
    propertyName: z.string(),
    occupancy: z.object({ rooms: z.number().int(), occupied: z.number().int(), pct: z.number() }),
    arrivals: z.array(BookingListItemDto),
    departures: z.array(BookingListItemDto),
    inHouse: z.number().int(),
    guestsInHouse: z.number().int(),
    roomStates: z.object({
      dirty: z.number().int(),
      cleaning: z.number().int(),
      clean: z.number().int(),
      inspected: z.number().int(),
      repair: z.number().int(),
    }),
    arrivalsNotReady: z.number().int().describe('Заезд сегодня, а номер ещё не проверен'),
    overdueTasks: z.number().int(),
    openMaintenance: z.number().int(),
    overduePrepayments: z.array(BookingListItemDto),
    shift: z
      .object({ id: z.uuid(), number: z.number().int(), openedBy: z.string(), openedAt: z.iso.datetime(), expectedCash: z.number().int() })
      .nullable(),
    clockedIn: z.boolean(),
  })
  .meta({ id: 'Dashboard' });

export const dashboardRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = app.deps.db;

  app.get(
    '/dashboard',
    {
      schema: { tags: ['Сегодня'], summary: 'Сводка дня для ресепшена и управляющего', params: P, response: { 200: DashboardDto } },
      config: { permission: 'dashboard.view' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const day = today(ctx);
      const canBookings = can(ctx, 'booking.view');
      const arrivals = canBookings ? (await listBookings(db, ctx, { view: 'arrivals', limit: 200 })).items : [];
      const departures = canBookings ? (await listBookings(db, ctx, { view: 'departures', limit: 200 })).items : [];
      const inHouseList = canBookings ? (await listBookings(db, ctx, { view: 'inhouse', limit: 200 })).items : [];
      const tentative = canBookings ? (await listBookings(db, ctx, { status: ['tentative'], limit: 200 })).items : [];

      const roomRows = await db.select({ id: rooms.id, hk: rooms.hkStatus }).from(rooms).where(and(eq(rooms.propertyId, ctx.propertyId), eq(rooms.isActive, true)));
      const states = { dirty: 0, cleaning: 0, clean: 0, inspected: 0, repair: 0 };
      for (const r of roomRows) states[r.hk] += 1;
      const [occ] = await db.execute<{ n: string }>(sql`
        select count(*) as n from bookings
        where property_id = ${ctx.propertyId} and status in ('confirmed','checked_in','checked_out','tentative')
          and arrival <= ${day} and departure > ${day}
      `);
      const occupied = Number(occ?.n ?? 0);
      const [overdue] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(hkTasks)
        .where(
          and(
            eq(hkTasks.propertyId, ctx.propertyId),
            inArray(hkTasks.status, ['open', 'in_progress']),
            sql`${hkTasks.dueAt} < now()`,
          ),
        );
      const [maint] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(maintenanceRequests)
        .where(and(eq(maintenanceRequests.propertyId, ctx.propertyId), inArray(maintenanceRequests.status, ['open', 'in_progress'])));

      let shift: { id: string; number: number; openedBy: string; openedAt: string; expectedCash: number } | null = null;
      if (can(ctx, 'cash.view')) {
        const s = await openShift(db, ctx);
        if (s) {
          const report = await buildReport(db, ctx, s);
          shift = { id: s.id, number: s.number, openedBy: report.openedBy, openedAt: s.openedAt.toISOString(), expectedCash: report.expectedCash };
        }
      }
      return {
        businessDate: day,
        propertyName: ctx.property.name,
        occupancy: { rooms: roomRows.length, occupied, pct: roomRows.length ? Math.round((occupied / roomRows.length) * 1000) / 10 : 0 },
        arrivals,
        departures,
        inHouse: inHouseList.length,
        guestsInHouse: inHouseList.reduce((a, b) => a + b.adults + b.children, 0),
        roomStates: states,
        arrivalsNotReady: arrivals.filter((a) => a.status !== 'checked_in' && a.roomHkStatus !== 'inspected').length,
        overdueTasks: overdue?.n ?? 0,
        openMaintenance: maint?.n ?? 0,
        overduePrepayments: tentative.filter((b) => b.prepaymentOverdue),
        shift,
        clockedIn: ctx.actor.id ? await isClockedIn(db, ctx.propertyId, ctx.actor.id) : false,
      };
    },
  );
};
