import { aliasedTable, and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { audit, emit } from '../../core/audit.ts';
import { can, requirePermission, type PropertyContext } from '../../core/context.ts';
import { nextNumber } from '../../core/counters.ts';
import type { Deps } from '../../core/deps.ts';
import { iso } from '../../core/http.ts';
import type { DbOrTx } from '../../db/client.ts';
import {
  attendanceEvents,
  bookings,
  cashMovements,
  cashRegisters,
  cashShifts,
  companies,
  folioItems,
  guests,
  payments,
  users,
  type ZReport,
  type ZReportLine,
} from '../../db/schema/index.ts';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { fullName, trimOrNull } from '../../lib/normalize.ts';
import { decodeCursor, pageOf } from '../../lib/pagination.ts';
import { loadBooking, STATUS_LABEL, today } from '../bookings/service.ts';
import { balanceOf } from '../folio/balance.ts';

type PaymentRow = typeof payments.$inferSelect;
type ShiftRow = typeof cashShifts.$inferSelect;

export const METHOD_LABEL: Record<PaymentRow['method'], string> = {
  cash: 'Наличные',
  card: 'Банковская карта',
  qr: 'QR / перевод',
  transfer: 'Банковский перевод',
  invoice: 'Безнал по счёту',
};
const PAYMENT_TYPE_LABEL: Record<PaymentRow['paymentType'], string> = {
  special: 'Спеццена',
  cash: 'Наличные',
  cashless: 'Безналичные',
};
const KIND_LABEL: Record<PaymentRow['kind'], string> = {
  payment: 'Оплата',
  refund: 'Возврат',
  deposit: 'Депозит',
  deposit_return: 'Возврат депозита',
};

/** Знак документа для кассы: приход +, расход -; сторно переворачивает знак. */
export function signOf(p: Pick<PaymentRow, 'kind' | 'stornoOf'>): 1 | -1 {
  const base = p.kind === 'payment' || p.kind === 'deposit' ? 1 : -1;
  return (p.stornoOf ? -base : base) as 1 | -1;
}

// ── Отметка прихода: условие открытия смены ────────────────────────────────

export async function isClockedIn(tx: DbOrTx, propertyId: string, userId: string): Promise<boolean> {
  const [last] = await tx
    .select({ kind: attendanceEvents.kind, at: attendanceEvents.at })
    .from(attendanceEvents)
    .where(and(eq(attendanceEvents.propertyId, propertyId), eq(attendanceEvents.userId, userId), isNull(attendanceEvents.supersededBy)))
    .orderBy(desc(attendanceEvents.at))
    .limit(1);
  // Смена у ресепшена - сутки; отметка старше 26 часов уже не считается.
  return !!last && last.kind === 'in' && Date.now() - last.at.getTime() < 26 * 3_600_000;
}

// ── Смена ──────────────────────────────────────────────────────────────────

async function defaultRegister(tx: DbOrTx, ctx: PropertyContext) {
  const [reg] = await tx.select().from(cashRegisters).where(eq(cashRegisters.propertyId, ctx.propertyId)).orderBy(asc(cashRegisters.createdAt)).limit(1);
  if (reg) return reg;
  const [created] = await tx.insert(cashRegisters).values({ id: newId(), propertyId: ctx.propertyId, name: 'Ресепшен' }).returning();
  return created!;
}

export async function openShift(tx: DbOrTx, ctx: PropertyContext): Promise<ShiftRow | null> {
  const reg = await defaultRegister(tx, ctx);
  const [s] = await tx.select().from(cashShifts).where(and(eq(cashShifts.registerId, reg.id), eq(cashShifts.status, 'open'))).limit(1);
  return s ?? null;
}

async function requireOpenShift(tx: DbOrTx, ctx: PropertyContext): Promise<ShiftRow> {
  const reg = await defaultRegister(tx, ctx);
  const [s] = await tx
    .select()
    .from(cashShifts)
    .where(and(eq(cashShifts.registerId, reg.id), eq(cashShifts.status, 'open')))
    .limit(1)
    .for('share');
  if (!s) throw conflict('shift.closed', 'Кассовая смена не открыта', 'Без открытой смены принять оплату нельзя.');
  return s;
}

const openedByUser = aliasedTable(users, 'opened_by_user');
const closedByUser = aliasedTable(users, 'closed_by_user');
const handedUser = aliasedTable(users, 'handed_user');
const acceptedUser = aliasedTable(users, 'accepted_user');

export async function shiftDto(tx: DbOrTx, shiftId: string) {
  const [r] = await tx
    .select({
      s: cashShifts,
      registerName: cashRegisters.name,
      openedBy: openedByUser.fullName,
      closedBy: closedByUser.fullName,
      handedOverTo: handedUser.fullName,
      acceptedBy: acceptedUser.fullName,
      count: sql<number>`(select count(*) from payments p where p.shift_id = ${cashShifts.id})::int`,
    })
    .from(cashShifts)
    .innerJoin(cashRegisters, eq(cashRegisters.id, cashShifts.registerId))
    .leftJoin(openedByUser, eq(openedByUser.id, cashShifts.openedBy))
    .leftJoin(closedByUser, eq(closedByUser.id, cashShifts.closedBy))
    .leftJoin(handedUser, eq(handedUser.id, cashShifts.handedOverTo))
    .leftJoin(acceptedUser, eq(acceptedUser.id, cashShifts.acceptedBy))
    .where(eq(cashShifts.id, shiftId));
  if (!r) throw notFound('shift.not_found', 'Смена не найдена');
  const s = r.s;
  return {
    id: s.id,
    number: s.number,
    status: s.status,
    registerName: r.registerName,
    openedAt: s.openedAt.toISOString(),
    openedBy: { id: s.openedBy, name: r.openedBy ?? '' },
    openingCash: s.openingCash,
    closedAt: iso(s.closedAt),
    closedBy: r.closedBy,
    expectedCash: s.expectedCash,
    countedCash: s.countedCash,
    discrepancy: s.discrepancy,
    discrepancyComment: s.discrepancyComment,
    handedOverTo: r.handedOverTo,
    acceptedBy: r.acceptedBy,
    acceptedAt: iso(s.acceptedAt),
    paymentsCount: r.count,
    version: s.version,
  };
}

/**
 * X- и Z-отчёт считаются одной функцией: X - на текущий момент, Z - то же
 * самое плюс пересчитанные наличные, и после него смена неизменна.
 */
export async function buildReport(tx: DbOrTx, ctx: PropertyContext, shift: ShiftRow, close?: { countedCash: number; comment: string | null; closedBy: string; closedAt: Date }): Promise<ZReport> {
  const rows = await tx.select().from(payments).where(eq(payments.shiftId, shift.id));
  const line = (key: string, label: string, list: PaymentRow[], signed = false): ZReportLine => ({
    key,
    label,
    amount: list.reduce((acc, p) => acc + (signed ? signOf(p) * p.amount : p.amount), 0),
    count: list.length,
  });
  const originals = rows.filter((p) => !p.stornoOf);
  const incoming = originals.filter((p) => p.kind === 'payment' || p.kind === 'deposit');
  const byMethod = (Object.keys(METHOD_LABEL) as PaymentRow['method'][]).map((m) =>
    line(m, METHOD_LABEL[m], incoming.filter((p) => p.method === m)),
  );
  const byPaymentType = (['special', 'cash', 'cashless'] as const).map((t) =>
    line(t, PAYMENT_TYPE_LABEL[t], rows.filter((p) => p.paymentType === t), true),
  );
  const refunds = line('refunds', 'Возвраты', originals.filter((p) => p.kind === 'refund' || p.kind === 'deposit_return'));
  const stornoRows = rows.filter((p) => p.stornoOf);
  const stornos = { key: 'stornos', label: 'Сторно', amount: stornoRows.reduce((a, p) => a + p.amount, 0), count: stornoRows.length };
  const deposits = line('deposits', 'Депозиты (нетто)', rows.filter((p) => p.kind === 'deposit' || p.kind === 'deposit_return'), true);
  const moves = await tx.select().from(cashMovements).where(eq(cashMovements.shiftId, shift.id));
  const withdrawalRows = moves.filter((m) => m.kind === 'withdrawal');
  const depositRows = moves.filter((m) => m.kind === 'deposit');
  const withdrawals = { key: 'withdrawals', label: 'Выемка', amount: withdrawalRows.reduce((a, m) => a + m.amount, 0), count: withdrawalRows.length };
  const cashDeposits = { key: 'cash_deposits', label: 'Внесение', amount: depositRows.reduce((a, m) => a + m.amount, 0), count: depositRows.length };
  const cashRows = rows.filter((p) => p.method === 'cash');
  const cashIn = cashRows.filter((p) => signOf(p) > 0).reduce((a, p) => a + p.amount, 0) + cashDeposits.amount;
  const cashOut = cashRows.filter((p) => signOf(p) < 0).reduce((a, p) => a + p.amount, 0) + withdrawals.amount;
  const expectedCash = shift.openingCash + cashIn - cashOut;

  const special = await tx
    .selectDistinct({ b: bookings, g: guests, approvedBy: users.fullName })
    .from(payments)
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .innerJoin(guests, eq(guests.id, bookings.guestId))
    .leftJoin(users, eq(users.id, bookings.priceApprovedBy))
    .where(and(eq(payments.shiftId, shift.id), eq(bookings.priceMode, 'special')));

  const [opener] = await tx.select({ name: users.fullName }).from(users).where(eq(users.id, shift.openedBy));
  const countedCash = close?.countedCash ?? expectedCash;
  return {
    shiftNumber: shift.number,
    openedAt: shift.openedAt.toISOString(),
    closedAt: (close?.closedAt ?? new Date()).toISOString(),
    openedBy: opener?.name ?? '',
    closedBy: close?.closedBy ?? '',
    currency: ctx.property.currency,
    byMethod,
    byPaymentType,
    refunds,
    stornos,
    deposits,
    withdrawals,
    cashDeposits,
    openingCash: shift.openingCash,
    cashIn,
    cashOut,
    expectedCash,
    countedCash,
    discrepancy: countedCash - expectedCash,
    discrepancyComment: close?.comment ?? null,
    specialPrices: special.map((r) => ({
      bookingNumber: r.b.number,
      guest: fullName(r.g),
      basis: r.b.priceReason ?? '',
      approvedBy: r.approvedBy ?? '',
      discount: r.b.baseTotal - r.b.accommodationTotal,
    })),
  };
}

export async function cashState(deps: Deps, ctx: PropertyContext) {
  const db = deps.db;
  const reg = await defaultRegister(db, ctx);
  const shift = await openShift(db, ctx);
  const [prev] = await db
    .select({ id: cashShifts.id })
    .from(cashShifts)
    .where(and(eq(cashShifts.registerId, reg.id), eq(cashShifts.status, 'closed')))
    .orderBy(desc(cashShifts.closedAt))
    .limit(1);
  return {
    shift: shift ? await shiftDto(db, shift.id) : null,
    report: shift ? await buildReport(db, ctx, shift) : null,
    previous: prev ? await shiftDto(db, prev.id) : null,
    clockedIn: ctx.actor.id ? await isClockedIn(db, ctx.propertyId, ctx.actor.id) : false,
    fiscalDriver: deps.fiscal.name,
    fiscalTest: deps.fiscal.isTest,
  };
}

export async function openNewShift(deps: Deps, ctx: PropertyContext, input: { openingCash?: number | undefined }) {
  return deps.db.transaction(async (tx) => {
    if (!ctx.actor.id || !(await isClockedIn(tx, ctx.propertyId, ctx.actor.id))) {
      throw forbidden('attendance.required', 'Сначала отметьте приход', 'Без отметки о приходе открыть кассовую смену нельзя.');
    }
    const reg = await defaultRegister(tx, ctx);
    const existing = await openShift(tx, ctx);
    if (existing) {
      const [who] = await tx.select({ name: users.fullName }).from(users).where(eq(users.id, existing.openedBy));
      throw conflict('shift.already_open', `Смена ${existing.number} уже открыта: ${who?.name ?? ''}`, undefined, { shiftId: existing.id });
    }
    const [prev] = await tx
      .select()
      .from(cashShifts)
      .where(and(eq(cashShifts.registerId, reg.id), eq(cashShifts.status, 'closed')))
      .orderBy(desc(cashShifts.closedAt))
      .limit(1);
    // Передача смены с подписью обоих: закрывший подписал Z-отчётом,
    // открывающий подписывает приёмом остатка.
    if (prev && !prev.acceptedBy) {
      await tx.update(cashShifts).set({ acceptedBy: ctx.actor.id, acceptedAt: new Date() }).where(eq(cashShifts.id, prev.id));
      await audit(tx, ctx, {
        action: 'shift.accept',
        entityType: 'shift',
        entityId: prev.id,
        entityLabel: `Смена ${prev.number}`,
        changes: { acceptedBy: [null, ctx.actor.name], cash: [null, prev.countedCash] },
      });
    }
    const openingCash = input.openingCash ?? prev?.countedCash ?? 0;
    const id = newId();
    const number = await nextNumber(tx, ctx.propertyId, 'shift');
    await tx.insert(cashShifts).values({ id, propertyId: ctx.propertyId, registerId: reg.id, number, openedBy: ctx.actor.id, openingCash });
    await audit(tx, ctx, {
      action: 'shift.open',
      entityType: 'shift',
      entityId: id,
      entityLabel: `Смена ${number}`,
      changes: { openingCash: [null, openingCash] },
      reason: prev && openingCash !== prev.countedCash ? `Остаток при открытии отличается от Z-отчёта смены ${prev.number}` : null,
    });
    await emit(tx, ctx, 'shift.changed', id);
    return id;
  });
}

export async function closeShift(
  deps: Deps,
  ctx: PropertyContext,
  shiftId: string,
  input: { countedCash: number; discrepancyComment?: string | null | undefined; handedOverTo?: string | null | undefined },
) {
  return deps.db.transaction(async (tx) => {
    const [shift] = await tx
      .select()
      .from(cashShifts)
      .where(and(eq(cashShifts.id, shiftId), eq(cashShifts.propertyId, ctx.propertyId)))
      .for('update');
    if (!shift) throw notFound('shift.not_found', 'Смена не найдена');
    if (shift.status !== 'open') throw conflict('shift.closed', 'Смена уже закрыта Z-отчётом');
    if (shift.openedBy !== ctx.actor.id && !can(ctx, 'cash.reports')) {
      throw forbidden('shift.not_owner', 'Закрыть смену может тот, кто её открыл, или старший администратор');
    }
    const closedAt = new Date();
    const report = await buildReport(tx, ctx, shift, {
      countedCash: input.countedCash,
      comment: trimOrNull(input.discrepancyComment),
      closedBy: ctx.actor.name,
      closedAt,
    });
    if (report.discrepancy !== 0 && !report.discrepancyComment) {
      throw new AppError(422, 'shift.discrepancy_comment', 'Есть расхождение с расчётной суммой: нужен комментарий', undefined, {
        expectedCash: report.expectedCash,
        discrepancy: report.discrepancy,
      });
    }
    if (input.handedOverTo) {
      const [u] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, input.handedOverTo), eq(users.orgId, ctx.orgId)));
      if (!u) throw notFound('user.not_found', 'Сотрудник для передачи смены не найден');
    }
    await tx
      .update(cashShifts)
      .set({
        status: 'closed',
        closedAt,
        closedBy: ctx.actor.id,
        expectedCash: report.expectedCash,
        countedCash: input.countedCash,
        discrepancy: report.discrepancy,
        discrepancyComment: report.discrepancyComment,
        zReport: report,
        handedOverTo: input.handedOverTo ?? null,
        version: shift.version + 1,
      })
      .where(eq(cashShifts.id, shift.id));
    await audit(tx, ctx, {
      action: 'shift.close',
      entityType: 'shift',
      entityId: shift.id,
      entityLabel: `Смена ${shift.number}`,
      changes: {
        expectedCash: [null, report.expectedCash],
        countedCash: [null, input.countedCash],
        discrepancy: [null, report.discrepancy],
      },
      reason: report.discrepancyComment,
    });
    await emit(tx, ctx, 'shift.changed', shift.id);
    return shift.id;
  });
}

/** Выемка наличных (сдали бухгалтеру) или внесение (размен). С причиной, в открытую смену. */
export async function addCashMovement(
  deps: Deps,
  ctx: PropertyContext,
  shiftId: string,
  input: { kind: 'withdrawal' | 'deposit'; amount: number; reason: string },
) {
  const reason = trimOrNull(input.reason);
  if (!reason) throw badRequest('cash.reason_required', 'Укажите, кому выдано или откуда внесено');
  return deps.db.transaction(async (tx) => {
    const shift = await requireOpenShift(tx, ctx);
    if (shift.id !== shiftId) throw conflict('shift.not_current', 'Движение наличных - только в текущей открытой смене');
    if (input.kind === 'withdrawal') {
      const report = await buildReport(tx, ctx, shift);
      if (input.amount > report.expectedCash) {
        throw badRequest('cash.not_enough', 'В кассе меньше наличных, чем вы хотите изъять', undefined, { expectedCash: report.expectedCash });
      }
    }
    const id = newId();
    await tx.insert(cashMovements).values({ id, propertyId: ctx.propertyId, shiftId: shift.id, kind: input.kind, amount: input.amount, reason, createdBy: ctx.actor.id! });
    await audit(tx, ctx, {
      action: `cash.${input.kind}`,
      entityType: 'shift',
      entityId: shift.id,
      entityLabel: `Смена ${shift.number}`,
      changes: { [input.kind === 'withdrawal' ? 'Выемка' : 'Внесение']: [null, input.amount] },
      reason,
    });
    await emit(tx, ctx, 'shift.changed', shift.id);
    return id;
  });
}

export async function listShifts(tx: DbOrTx, ctx: PropertyContext, q: { cursor?: string | undefined; limit: number }) {
  const conds: SQL[] = [eq(cashShifts.propertyId, ctx.propertyId)];
  if (!can(ctx, 'cash.reports') && ctx.actor.id) conds.push(eq(cashShifts.openedBy, ctx.actor.id));
  const cursor = decodeCursor<[number]>(q.cursor);
  if (cursor) conds.push(sql`${cashShifts.number} < ${cursor[0]}`);
  const rows = await tx.select({ id: cashShifts.id, number: cashShifts.number }).from(cashShifts).where(and(...conds)).orderBy(desc(cashShifts.number)).limit(q.limit + 1);
  const page = pageOf(rows, q.limit, (r) => [r.number]);
  return { items: await Promise.all(page.items.map((r) => shiftDto(tx, r.id))), nextCursor: page.nextCursor };
}

// ── Оплаты ─────────────────────────────────────────────────────────────────

export async function paymentDtos(tx: DbOrTx, conds: SQL[], fiscalTest: boolean, order: 'asc' | 'desc' = 'asc', limit = 500) {
  const rows = await tx
    .select({
      p: payments,
      shiftNumber: cashShifts.number,
      bookingNumber: bookings.number,
      g: guests,
      companyName: companies.name,
      createdBy: users.fullName,
    })
    .from(payments)
    .innerJoin(cashShifts, eq(cashShifts.id, payments.shiftId))
    .innerJoin(users, eq(users.id, payments.createdBy))
    .leftJoin(bookings, eq(bookings.id, payments.bookingId))
    .leftJoin(guests, eq(guests.id, bookings.guestId))
    .leftJoin(companies, eq(companies.id, payments.companyId))
    .where(and(...conds))
    .orderBy(order === 'asc' ? asc(payments.createdAt) : desc(payments.createdAt), order === 'asc' ? asc(payments.number) : desc(payments.number))
    .limit(limit);
  return rows.map((r) => ({
    id: r.p.id,
    number: r.p.number,
    shiftId: r.p.shiftId,
    shiftNumber: r.shiftNumber,
    bookingId: r.p.bookingId,
    bookingNumber: r.bookingNumber,
    guestName: r.g ? fullName(r.g) : null,
    kind: r.p.kind,
    method: r.p.method,
    paymentType: r.p.paymentType,
    amount: r.p.amount,
    signedAmount: signOf(r.p) * r.p.amount,
    payer: r.p.payer,
    companyName: r.companyName,
    comment: r.p.comment,
    fiscalStatus: r.p.fiscalStatus,
    fiscalNumber: r.p.fiscalNumber,
    fiscalTest,
    stornoOf: r.p.stornoOf,
    stornoReason: r.p.stornoReason,
    reversedBy: r.p.reversedBy,
    createdAt: r.p.createdAt.toISOString(),
    createdBy: r.createdBy,
  }));
}

/** Пробить чек. Вызывается после коммита: касса - внешнее устройство, транзакцию она не держит. */
async function fiscalize(deps: Deps, ctx: PropertyContext, paymentId: string) {
  const [p] = await deps.db.select().from(payments).where(eq(payments.id, paymentId));
  if (!p || p.fiscalStatus !== 'pending') return;
  const result = await deps.fiscal.register({
    paymentNumber: p.number,
    operation: signOf(p) > 0 ? 'sale' : 'refund',
    method: p.method,
    amount: p.amount,
    currency: ctx.property.currency,
    description: `${KIND_LABEL[p.kind]}${p.stornoOf ? ' (сторно)' : ''}`,
  });
  if (result.status === 'printed') {
    await deps.db
      .update(payments)
      .set({ fiscalStatus: 'printed', fiscalNumber: result.fiscalNumber, fiscalSign: result.fiscalSign, fiscalAt: result.at })
      .where(eq(payments.id, p.id));
  } else {
    await deps.db.update(payments).set({ fiscalStatus: 'failed' }).where(eq(payments.id, p.id));
  }
}

export async function createPayment(
  deps: Deps,
  ctx: PropertyContext,
  input: {
    bookingId: string;
    kind: PaymentRow['kind'];
    method: PaymentRow['method'];
    amount: number;
    payer?: 'guest' | 'company' | undefined;
    comment?: string | null | undefined;
  },
) {
  if (input.kind === 'payment' || input.kind === 'deposit') requirePermission(ctx, 'payment.accept', 'Принимать оплату может администратор ресепшена');
  else requirePermission(ctx, 'payment.refund', 'Возврат оформляет администратор ресепшена');

  const id = await deps.db.transaction(async (tx) => {
    const shift = await requireOpenShift(tx, ctx);
    const b = await loadBooking(tx, ctx, input.bookingId, true);
    if ((b.status === 'cancelled' || b.status === 'no_show') && (input.kind === 'payment' || input.kind === 'deposit')) {
      throw conflict('booking.closed', `Бронь ${STATUS_LABEL[b.status].toLowerCase()}: принять оплату нельзя`);
    }
    const bal = await balanceOf(tx, b.id);
    if (input.kind === 'refund') {
      if (input.amount > bal.paid) {
        throw badRequest('refund.too_much', 'Вернуть можно не больше, чем оплачено по брони', undefined, { paid: bal.paid });
      }
      const limit = ctx.property.settings.refundLimit;
      if (input.amount > limit && !can(ctx, 'payment.refund.unlimited')) {
        throw forbidden('refund.over_limit', 'Возврат больше лимита - только с управляющим', undefined, { limit });
      }
    }
    if (input.kind === 'deposit_return' && input.amount > bal.deposit) {
      throw badRequest('deposit.too_much', 'Вернуть можно не больше внесённого депозита', undefined, { deposit: bal.deposit });
    }
    if (input.method === 'invoice' && !b.companyId) {
      throw badRequest('payment.invoice_company', 'Безнал по счёту - только для брони с компанией-плательщиком');
    }
    const payer = input.payer ?? (input.method === 'invoice' ? 'company' : 'guest');
    if (payer === 'company' && !b.companyId) throw badRequest('payment.company_missing', 'У брони нет компании-плательщика');

    const pid = newId();
    const number = await nextNumber(tx, ctx.propertyId, 'payment');
    await tx.insert(payments).values({
      id: pid,
      propertyId: ctx.propertyId,
      number,
      shiftId: shift.id,
      bookingId: b.id,
      groupId: b.groupId,
      kind: input.kind,
      method: input.method,
      paymentType: b.paymentType,
      amount: input.amount,
      payer,
      companyId: payer === 'company' ? b.companyId : null,
      comment: trimOrNull(input.comment),
      fiscalStatus: input.method === 'invoice' ? 'not_required' : 'pending',
      createdBy: ctx.actor.id!,
    });
    await audit(tx, ctx, {
      action: `payment.${input.kind}`,
      entityType: 'booking',
      entityId: b.id,
      entityLabel: `Бронь ${b.number}`,
      changes: { [`${KIND_LABEL[input.kind]} ${number}`]: [null, `${input.amount} · ${METHOD_LABEL[input.method]}`] },
    });

    // Предоплата внесена - бронь подтверждается сама (ТЗ: «подтверждена (предоплата)»).
    if (input.kind === 'payment' && b.status === 'tentative') {
      const paid = bal.paid + input.amount;
      if (b.prepaymentAmount && paid >= b.prepaymentAmount) {
        await tx
          .update(bookings)
          .set({ status: 'confirmed', prepaymentDueAt: null, updatedAt: new Date(), updatedBy: ctx.actor.id, version: b.version + 1 })
          .where(eq(bookings.id, b.id));
        await audit(tx, ctx, {
          action: 'booking.confirmed',
          entityType: 'booking',
          entityId: b.id,
          entityLabel: `Бронь ${b.number}`,
          changes: { status: [STATUS_LABEL.tentative, STATUS_LABEL.confirmed] },
          reason: 'Внесена предоплата',
        });
      }
    }
    await emit(tx, ctx, 'payment.created', pid, { bookingId: b.id, shiftId: shift.id });
    await emit(tx, ctx, 'booking.changed', b.id, { roomId: b.roomId });
    return pid;
  });
  await fiscalize(deps, ctx, id);
  return id;
}

/**
 * Сторно оплаты. Удалить оплату нельзя (ТЗ). Сторно в открытой смене -
 * старший администратор; оплаты из закрытой Z-отчётом смены - только
 * управляющий. Документ сторно ложится в текущую смену: закрытая не меняется.
 */
export async function stornoPayment(deps: Deps, ctx: PropertyContext, paymentId: string, reason: string) {
  const why = trimOrNull(reason);
  if (!why) throw badRequest('storno.reason_required', 'Укажите причину сторно');
  const id = await deps.db.transaction(async (tx) => {
    const [orig] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.id, paymentId), eq(payments.propertyId, ctx.propertyId)))
      .for('update');
    if (!orig) throw notFound('payment.not_found', 'Оплата не найдена');
    if (orig.stornoOf) throw conflict('storno.of_storno', 'Это уже документ сторно');
    if (orig.reversedBy) throw conflict('storno.done', 'Оплата уже сторнирована');
    const shift = await requireOpenShift(tx, ctx);
    if (orig.shiftId === shift.id) {
      requirePermission(ctx, 'payment.storno', 'Сторно в смене делает старший администратор');
    } else {
      requirePermission(ctx, 'payment.storno.closed', 'Сторно после Z-отчёта - только управляющий');
    }
    const sid = newId();
    const number = await nextNumber(tx, ctx.propertyId, 'payment');
    await tx.insert(payments).values({
      id: sid,
      propertyId: ctx.propertyId,
      number,
      shiftId: shift.id,
      bookingId: orig.bookingId,
      groupId: orig.groupId,
      kind: orig.kind,
      method: orig.method,
      paymentType: orig.paymentType,
      amount: orig.amount,
      payer: orig.payer,
      companyId: orig.companyId,
      comment: `Сторно документа ${orig.number}`,
      fiscalStatus: orig.fiscalStatus === 'not_required' ? 'not_required' : 'pending',
      stornoOf: orig.id,
      stornoReason: why,
      createdBy: ctx.actor.id!,
    });
    await tx.update(payments).set({ reversedBy: sid }).where(eq(payments.id, orig.id));
    await audit(tx, ctx, {
      action: 'payment.storno',
      entityType: 'booking',
      entityId: orig.bookingId ?? orig.id,
      entityLabel: `Оплата ${orig.number}`,
      changes: { [`Сторно ${number}`]: [`${KIND_LABEL[orig.kind]} ${orig.amount} · ${METHOD_LABEL[orig.method]}`, null] },
      reason: why,
    });
    await emit(tx, ctx, 'payment.created', sid, { bookingId: orig.bookingId, shiftId: shift.id });
    if (orig.bookingId) await emit(tx, ctx, 'booking.changed', orig.bookingId);
    return sid;
  });
  await fiscalize(deps, ctx, id);
  return id;
}

export async function retryFiscal(deps: Deps, ctx: PropertyContext, paymentId: string) {
  const [p] = await deps.db.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.propertyId, ctx.propertyId)));
  if (!p) throw notFound('payment.not_found', 'Оплата не найдена');
  if (p.fiscalStatus !== 'failed') throw conflict('fiscal.not_failed', 'Чек уже пробит или не нужен');
  await deps.db.update(payments).set({ fiscalStatus: 'pending' }).where(eq(payments.id, p.id));
  await fiscalize(deps, ctx, p.id);
}

// ── Начисления и счёт ──────────────────────────────────────────────────────

export const CHARGE_LABEL: Record<(typeof folioItems.$inferSelect)['kind'], string> = {
  minibar: 'Мини-бар',
  restaurant: 'Ресторан',
  laundry: 'Прачечная',
  transfer: 'Трансфер',
  damage: 'Порча имущества',
  breakfast: 'Завтрак',
  service: 'Услуга',
  other: 'Прочее',
};

export async function addCharge(
  deps: Deps,
  ctx: PropertyContext,
  bookingId: string,
  input: { kind: (typeof folioItems.$inferSelect)['kind']; description?: string | null | undefined; quantity: number; unitAmount: number; serviceDate?: string | undefined },
) {
  return deps.db.transaction(async (tx) => {
    const b = await loadBooking(tx, ctx, bookingId, true);
    if (b.status === 'cancelled' || b.status === 'no_show' || b.status === 'checked_out') {
      throw conflict('booking.closed', `Бронь в статусе «${STATUS_LABEL[b.status]}»: начисления закрыты`);
    }
    const id = newId();
    const amount = input.quantity * input.unitAmount;
    const description = trimOrNull(input.description) ?? CHARGE_LABEL[input.kind];
    await tx.insert(folioItems).values({
      id,
      propertyId: ctx.propertyId,
      bookingId: b.id,
      kind: input.kind,
      description,
      quantity: input.quantity,
      unitAmount: input.unitAmount,
      amount,
      serviceDate: input.serviceDate ?? today(ctx),
      createdBy: ctx.actor.id,
    });
    await audit(tx, ctx, {
      action: 'charge.create',
      entityType: 'booking',
      entityId: b.id,
      entityLabel: `Бронь ${b.number}`,
      changes: { [description]: [null, amount] },
    });
    await emit(tx, ctx, 'booking.changed', b.id);
    return id;
  });
}

export async function stornoCharge(deps: Deps, ctx: PropertyContext, chargeId: string, reason: string) {
  const why = trimOrNull(reason);
  if (!why) throw badRequest('storno.reason_required', 'Укажите причину сторно');
  return deps.db.transaction(async (tx) => {
    const [orig] = await tx
      .select()
      .from(folioItems)
      .where(and(eq(folioItems.id, chargeId), eq(folioItems.propertyId, ctx.propertyId)))
      .for('update');
    if (!orig) throw notFound('charge.not_found', 'Начисление не найдено');
    if (orig.stornoOf) throw conflict('storno.of_storno', 'Это уже документ сторно');
    if (orig.reversedBy) throw conflict('storno.done', 'Начисление уже сторнировано');
    const b = await loadBooking(tx, ctx, orig.bookingId, true);
    if (b.status === 'checked_out') requirePermission(ctx, 'payment.storno.closed', 'После выезда сторно делает управляющий');
    const id = newId();
    await tx.insert(folioItems).values({
      id,
      propertyId: ctx.propertyId,
      bookingId: orig.bookingId,
      kind: orig.kind,
      description: `Сторно: ${orig.description}`,
      quantity: orig.quantity,
      unitAmount: -orig.unitAmount,
      amount: -orig.amount,
      serviceDate: today(ctx),
      stornoOf: orig.id,
      stornoReason: why,
      createdBy: ctx.actor.id,
    });
    await tx.update(folioItems).set({ reversedBy: id }).where(eq(folioItems.id, orig.id));
    await audit(tx, ctx, {
      action: 'charge.storno',
      entityType: 'booking',
      entityId: b.id,
      entityLabel: `Бронь ${b.number}`,
      changes: { [orig.description]: [orig.amount, null] },
      reason: why,
    });
    await emit(tx, ctx, 'booking.changed', b.id);
    return id;
  });
}

export async function folio(deps: Deps, ctx: PropertyContext, bookingId: string) {
  const db = deps.db;
  const b = await loadBooking(db, ctx, bookingId);
  const [g] = await db.select().from(guests).where(eq(guests.id, b.guestId));
  const items = await db
    .select({ i: folioItems, by: users.fullName })
    .from(folioItems)
    .leftJoin(users, eq(users.id, folioItems.createdBy))
    .where(eq(folioItems.bookingId, b.id))
    .orderBy(asc(folioItems.createdAt));
  const pays = await paymentDtos(db, [eq(payments.bookingId, b.id)], deps.fiscal.isTest);
  return {
    bookingId: b.id,
    bookingNumber: b.number,
    status: b.status,
    guestName: g ? fullName(g) : '',
    paymentType: b.paymentType,
    accommodation: {
      nights: b.nights.length,
      baseTotal: b.baseTotal,
      discountTotal: b.baseTotal - b.accommodationTotal,
      amount: b.accommodationTotal,
      priceMode: b.priceMode,
      priceReason: b.priceReason,
    },
    meal: { amount: b.mealTotal },
    charges: items.map((r) => ({
      id: r.i.id,
      kind: r.i.kind,
      description: r.i.description,
      quantity: r.i.quantity,
      unitAmount: r.i.unitAmount,
      amount: r.i.amount,
      serviceDate: r.i.serviceDate,
      stornoOf: r.i.stornoOf,
      stornoReason: r.i.stornoReason,
      reversedBy: r.i.reversedBy,
      createdAt: r.i.createdAt.toISOString(),
      createdBy: r.by,
    })),
    payments: pays,
    balance: await balanceOf(db, b.id),
    prepaymentAmount: b.prepaymentAmount,
  };
}

export async function listPayments(
  deps: Deps,
  ctx: PropertyContext,
  q: { shiftId?: string | undefined; from?: string | undefined; to?: string | undefined; method?: PaymentRow['method'][] | undefined },
) {
  const conds: SQL[] = [eq(payments.propertyId, ctx.propertyId)];
  if (q.shiftId) conds.push(eq(payments.shiftId, q.shiftId));
  if (q.method?.length) conds.push(inArray(payments.method, q.method));
  const tz = ctx.property.timezone;
  if (q.from) conds.push(sql`(${payments.createdAt} at time zone ${tz})::date >= ${q.from}::date`);
  if (q.to) conds.push(sql`(${payments.createdAt} at time zone ${tz})::date <= ${q.to}::date`);
  return paymentDtos(deps.db, conds, deps.fiscal.isTest, 'desc', 1000);
}
