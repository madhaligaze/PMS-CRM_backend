import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { bookings, counters, hkTasks, properties, rooms } from '../db/schema/index.ts';
import { businessDate, isoWeekday, zonedToUtc } from '../lib/dates.ts';
import { newId } from '../lib/ids.ts';
import { allRights, PERMISSIONS } from '../lib/access.ts';
import { balanceOf } from '../modules/folio/balance.ts';
import { GENERAL_CHECKLIST } from '../modules/housekeeping/service.ts';
import { audit, emit } from './audit.ts';
import type { PropertyContext } from './context.ts';
import { purgeIdempotencyKeys } from './idempotency.ts';

/** Контекст системы: действия планировщика пишутся в журнал от имени «Система». */
function systemContext(p: typeof properties.$inferSelect): PropertyContext {
  return {
    orgId: p.orgId,
    propertyId: p.id,
    property: {
      name: p.name,
      timezone: p.timezone,
      currency: p.currency,
      checkInTime: p.checkInTime.slice(0, 5),
      checkOutTime: p.checkOutTime.slice(0, 5),
      settings: p.settings,
    },
    actor: { id: null, name: 'Система' },
    access: null,
    rights: allRights(),
    permissions: new Set(PERMISSIONS),
    requestId: null,
    ip: null,
  };
}

type Job = { name: string; everyMs: number; lockId: number; run: (app: FastifyInstance) => Promise<void> };

/**
 * Неоплаченная предварительная бронь снимается после срока предоплаты
 * (ТЗ: «автоматическое снятие неоплаченной брони»).
 */
async function autoCancelUnpaid(app: FastifyInstance) {
  const db = app.deps.db;
  const props = await db.select().from(properties);
  for (const p of props) {
    if (!p.settings.autoCancelUnpaid) continue;
    const ctx = systemContext(p);
    const due = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.propertyId, p.id), eq(bookings.status, 'tentative'), lt(bookings.prepaymentDueAt, new Date())));
    for (const b of due) {
      await db.transaction(async (tx) => {
        const [fresh] = await tx.select().from(bookings).where(eq(bookings.id, b.id)).for('update');
        if (!fresh || fresh.status !== 'tentative') return;
        const bal = await balanceOf(tx, b.id);
        if (fresh.prepaymentAmount && bal.paid >= fresh.prepaymentAmount) return;
        const reason = 'Не внесена предоплата в срок';
        await tx
          .update(bookings)
          .set({ status: 'cancelled', cancelReason: reason, cancelledAt: new Date(), prepaymentDueAt: null, updatedAt: new Date(), version: fresh.version + 1 })
          .where(eq(bookings.id, b.id));
        await audit(tx, ctx, {
          action: 'booking.cancelled',
          entityType: 'booking',
          entityId: b.id,
          entityLabel: `Бронь ${b.number}`,
          changes: { status: ['Предварительная', 'Отменена'] },
          reason,
        });
        await emit(tx, ctx, 'booking.changed', b.id, { roomId: b.roomId, status: 'cancelled' });
      });
      app.log.info({ booking: b.number }, 'бронь снята: не внесена предоплата');
    }
  }
}

function dayKey(day: string): number {
  return Number(day.replaceAll('-', ''));
}

/**
 * Задачи дня: ежедневная уборка занятых номеров и генеральная по графику.
 * Создаются один раз за операционные сутки гостиницы.
 */
async function dailyHousekeeping(app: FastifyInstance) {
  const db = app.deps.db;
  const props = await db.select().from(properties);
  for (const p of props) {
    const ctx = systemContext(p);
    const day = businessDate(new Date(), p.timezone);
    const [mark] = await db.select().from(counters).where(and(eq(counters.propertyId, p.id), eq(counters.name, 'hk-day')));
    if (mark && mark.value >= dayKey(day)) continue;

    await db.transaction(async (tx) => {
      const dueDaily = zonedToUtc(day, p.settings.dailyCleaningDue, p.timezone);
      const stayovers = await tx
        .select({ roomId: bookings.roomId })
        .from(bookings)
        .where(
          and(
            eq(bookings.propertyId, p.id),
            eq(bookings.status, 'checked_in'),
            lt(bookings.arrival, day),
            sql`${bookings.departure} > ${day}`,
          ),
        );
      const existing = await tx
        .select({ roomId: hkTasks.roomId, kind: hkTasks.kind })
        .from(hkTasks)
        .where(and(eq(hkTasks.propertyId, p.id), eq(hkTasks.businessDate, day)));
      const has = (roomId: string, kind: string) => existing.some((t) => t.roomId === roomId && t.kind === kind);

      for (const s of stayovers) {
        if (has(s.roomId, 'stayover')) continue;
        await tx.insert(hkTasks).values({
          id: newId(),
          propertyId: p.id,
          roomId: s.roomId,
          kind: 'stayover',
          businessDate: day,
          dueAt: dueDaily,
          // Вид задачи уже говорит «ежедневная»: примечание остаётся для слов людей.
          note: null,
        });
        // Занятый номер утром требует обслуживания.
        await tx
          .update(rooms)
          .set({ hkStatus: 'dirty', hkStatusAt: new Date(), hkStatusBy: null })
          .where(and(eq(rooms.id, s.roomId), inArray(rooms.hkStatus, ['clean', 'inspected'])));
      }

      if (isoWeekday(day) === p.settings.generalCleaningWeekday) {
        const roomRows = await tx.select({ id: rooms.id }).from(rooms).where(and(eq(rooms.propertyId, p.id), eq(rooms.isActive, true)));
        const dueGeneral = zonedToUtc(day, '20:00', p.timezone);
        for (const r of roomRows) {
          if (has(r.id, 'general')) continue;
          await tx.insert(hkTasks).values({
            id: newId(),
            propertyId: p.id,
            roomId: r.id,
            kind: 'general',
            businessDate: day,
            dueAt: dueGeneral,
            note: 'Генеральная уборка по графику: пропустить можно только с причиной',
            checklist: GENERAL_CHECKLIST.map((text) => ({ text, done: false })),
          });
        }
      }

      await tx
        .insert(counters)
        .values({ propertyId: p.id, name: 'hk-day', value: dayKey(day) })
        .onConflictDoUpdate({ target: [counters.propertyId, counters.name], set: { value: dayKey(day) } });
      await audit(tx, ctx, {
        action: 'hk.day_plan',
        entityType: 'property',
        entityId: p.id,
        entityLabel: p.name,
        changes: { stayovers: [null, stayovers.length], date: [null, day] },
      });
      await emit(tx, ctx, 'hk.task.changed', null);
    });
    app.log.info({ property: p.name, day }, 'план уборки на день создан');
  }
}

/** Просроченная задача уходит руководителю: событие один раз на задачу. */
async function overdueTasks(app: FastifyInstance) {
  await app.deps.db.execute(sql`
    insert into outbox_events (property_id, topic, entity_id, payload)
    select t.property_id, 'hk.task.overdue', t.id::text, jsonb_build_object('roomId', t.room_id, 'dueAt', t.due_at)
    from hk_tasks t
    where t.status in ('open', 'in_progress') and t.due_at < now()
      and not exists (select 1 from outbox_events o where o.topic = 'hk.task.overdue' and o.entity_id = t.id::text)
  `);
}

const JOBS: Job[] = [
  { name: 'auto-cancel-unpaid', everyMs: 5 * 60_000, lockId: 727101, run: autoCancelUnpaid },
  { name: 'daily-housekeeping', everyMs: 10 * 60_000, lockId: 727102, run: dailyHousekeeping },
  { name: 'overdue-tasks', everyMs: 5 * 60_000, lockId: 727103, run: overdueTasks },
  { name: 'purge-idempotency', everyMs: 60 * 60_000, lockId: 727104, run: purgeIdempotencyKeys },
];

/**
 * Простой планировщик в процессе API. Advisory lock гарантирует, что при
 * нескольких экземплярах задачу выполнит один. Когда задач станет больше,
 * их можно перенести в отдельный процесс-воркер без изменения логики.
 */
export function startScheduler(app: FastifyInstance): () => void {
  const timers: NodeJS.Timeout[] = [];
  const running = new Set<string>();
  const tick = async (job: Job) => {
    if (running.has(job.name)) return;
    running.add(job.name);
    try {
      await app.deps.sql.begin(async (tx) => {
        const [{ locked }] = (await tx`select pg_try_advisory_xact_lock(${job.lockId}) as locked`) as unknown as [{ locked: boolean }];
        if (!locked) return;
        await job.run(app);
      });
    } catch (err) {
      app.log.error({ err, job: job.name }, 'фоновая задача упала');
    } finally {
      running.delete(job.name);
    }
  };
  for (const job of JOBS) {
    timers.push(setTimeout(() => void tick(job), 3_000));
    timers.push(setInterval(() => void tick(job), job.everyMs));
  }
  return () => timers.forEach((t) => clearInterval(t));
}

export const jobs = { autoCancelUnpaid, dailyHousekeeping, overdueTasks };
