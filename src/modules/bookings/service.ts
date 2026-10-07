import { aliasedTable, and, asc, desc, eq, gt, inArray, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { audit, emit } from '../../core/audit.ts';
import { can, requirePermission, type PropertyContext } from '../../core/context.ts';
import { nextNumber } from '../../core/counters.ts';
import type { Deps } from '../../core/deps.ts';
import { iso } from '../../core/http.ts';
import type { Db, DbOrTx } from '../../db/client.ts';
import {
  bookingGroups,
  bookings,
  companies,
  guests,
  hkTasks,
  memberships,
  ratePlans,
  roomBlocks,
  roomOccupancy,
  rooms,
  roomTypes,
  users,
} from '../../db/schema/index.ts';
import { addDays, businessDate, diffDays, eachNight, zonedToUtc } from '../../lib/dates.ts';
import { AppError, badRequest, conflict, notFound, pgCode, preconditionFailed, unprocessable } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { fullName, trimOrNull } from '../../lib/normalize.ts';
import { decodeCursor, pageOf } from '../../lib/pagination.ts';
import { cleanRights, effectiveRights, type Access } from '../../lib/access.ts';
import { balanceOf, balances, type Balance } from '../folio/balance.ts';
import { resolveGuest } from '../guests/service.ts';
import { quote, type PriceMode } from '../rates/pricing.ts';
import type { CreateBookingInputT, UpdateBookingInputT } from './schemas.ts';

type BookingRow = typeof bookings.$inferSelect;
type Status = BookingRow['status'];

const ACTIVE: Status[] = ['tentative', 'confirmed', 'checked_in'];
export const STATUS_LABEL: Record<Status, string> = {
  tentative: 'Предварительная',
  confirmed: 'Подтверждена',
  checked_in: 'Заселён',
  checked_out: 'Выселен',
  cancelled: 'Отменена',
  no_show: 'Незаезд',
};

export const today = (ctx: PropertyContext) => businessDate(new Date(), ctx.property.timezone);

// ── Загрузка и представление ───────────────────────────────────────────────

export async function loadBooking(tx: DbOrTx, ctx: PropertyContext, id: string, forUpdate = false): Promise<BookingRow> {
  const q = tx.select().from(bookings).where(and(eq(bookings.id, id), eq(bookings.propertyId, ctx.propertyId)));
  const [row] = forUpdate ? await q.for('update') : await q;
  if (!row) throw notFound('booking.not_found', 'Бронь не найдена');
  return row;
}

function checkVersion(row: BookingRow, version: number | null | undefined) {
  if (version != null && row.version !== version) {
    throw preconditionFailed('Бронь уже изменил другой сотрудник', 'Обновите бронь и повторите действие.', {
      currentVersion: row.version,
    });
  }
}

function isPrepaymentOverdue(b: BookingRow, bal: Balance | undefined): boolean {
  if (b.status !== 'tentative' || !b.prepaymentDueAt) return false;
  if (b.prepaymentDueAt.getTime() > Date.now()) return false;
  return (bal?.paid ?? 0) < (b.prepaymentAmount ?? 0) || !b.prepaymentAmount;
}

const createdByUser = aliasedTable(users, 'created_by_user');
const cancelledByUser = aliasedTable(users, 'cancelled_by_user');
const approvedByUser = aliasedTable(users, 'approved_by_user');

export async function bookingDto(tx: DbOrTx, ctx: PropertyContext, id: string) {
  const [r] = await tx
    .select({
      b: bookings,
      g: guests,
      room: rooms,
      typeName: roomTypes.name,
      planName: ratePlans.name,
      companyName: companies.name,
      groupName: bookingGroups.name,
      createdBy: createdByUser.fullName,
      cancelledBy: cancelledByUser.fullName,
      approvedBy: approvedByUser.fullName,
    })
    .from(bookings)
    .innerJoin(guests, eq(guests.id, bookings.guestId))
    .innerJoin(rooms, eq(rooms.id, bookings.roomId))
    .innerJoin(roomTypes, eq(roomTypes.id, bookings.roomTypeId))
    .innerJoin(ratePlans, eq(ratePlans.id, bookings.ratePlanId))
    .leftJoin(companies, eq(companies.id, bookings.companyId))
    .leftJoin(bookingGroups, eq(bookingGroups.id, bookings.groupId))
    .leftJoin(createdByUser, eq(createdByUser.id, bookings.createdBy))
    .leftJoin(cancelledByUser, eq(cancelledByUser.id, bookings.cancelledBy))
    .leftJoin(approvedByUser, eq(approvedByUser.id, bookings.priceApprovedBy))
    .where(and(eq(bookings.id, id), eq(bookings.propertyId, ctx.propertyId)));
  if (!r) throw notFound('booking.not_found', 'Бронь не найдена');
  const b = r.b;
  const bal = await balanceOf(tx, b.id);
  const day = today(ctx);
  const arrivalToday = b.arrival === day && (b.status === 'tentative' || b.status === 'confirmed');
  return {
    id: b.id,
    number: b.number,
    status: b.status,
    guest: {
      id: r.g.id,
      fullName: fullName(r.g),
      phone: r.g.phone,
      isVip: r.g.isVip,
      blacklisted: r.g.blacklisted,
      blacklistReason: r.g.blacklistReason,
    },
    companyId: b.companyId,
    companyName: r.companyName,
    groupId: b.groupId,
    groupName: r.groupName,
    roomTypeId: b.roomTypeId,
    roomTypeName: r.typeName,
    roomId: b.roomId,
    roomNumber: r.room.number,
    roomHkStatus: r.room.hkStatus,
    arrival: b.arrival,
    departure: b.departure,
    nightsCount: diffDays(b.arrival, b.departure),
    adults: b.adults,
    children: b.children,
    ratePlanId: b.ratePlanId,
    ratePlanName: r.planName,
    meal: b.meal,
    source: b.source,
    paymentType: b.paymentType,
    priceMode: b.priceMode,
    discountPercent: b.discountPercent,
    specialNightly: b.specialNightly,
    priceReason: b.priceReason,
    priceApprovedBy: b.priceApprovedBy && r.approvedBy ? { id: b.priceApprovedBy, name: r.approvedBy } : null,
    nights: b.nights,
    baseTotal: b.baseTotal,
    accommodationTotal: b.accommodationTotal,
    mealTotal: b.mealTotal,
    discountTotal: b.baseTotal - b.accommodationTotal,
    prepaymentAmount: b.prepaymentAmount,
    prepaymentDueAt: iso(b.prepaymentDueAt),
    comment: b.comment,
    externalRef: b.externalRef,
    cancelReason: b.cancelReason,
    cancelledAt: iso(b.cancelledAt),
    cancelledBy: r.cancelledBy,
    checkedInAt: iso(b.checkedInAt),
    keyIssuedAt: iso(b.keyIssuedAt),
    checkedOutAt: iso(b.checkedOutAt),
    rating: b.rating,
    feedback: b.feedback,
    createdAt: b.createdAt.toISOString(),
    createdBy: r.createdBy,
    updatedAt: b.updatedAt.toISOString(),
    version: b.version,
    balance: can(ctx, 'folio.view') ? bal : null,
    flags: {
      prepaymentOverdue: isPrepaymentOverdue(b, bal),
      arrivalToday,
      departureToday: b.departure === day && b.status === 'checked_in',
      roomNotReady: arrivalToday && r.room.hkStatus !== 'inspected',
    },
  };
}

// ── Цена и права на неё ─────────────────────────────────────────────────────

type PriceInput = {
  priceMode: PriceMode;
  discountPercent?: number | null | undefined;
  specialNightly?: number | null | undefined;
  priceReason?: string | null | undefined;
  priceApprovedBy?: string | null | undefined;
  paymentType: 'cash' | 'cashless' | 'special';
};

/**
 * Ручная скидка - только с правом и причиной; сверх лимита управляющего -
 * только у управляющего. Спеццена - только с правом, основанием из списка
 * и тем, кто утвердил (ТЗ, «Разделение гостей по типу оплаты»).
 */
async function validatePrice(tx: DbOrTx, ctx: PropertyContext, p: PriceInput) {
  const reason = trimOrNull(p.priceReason);
  if (p.priceMode === 'rate') {
    if (p.paymentType === 'special') {
      throw badRequest('price.special_mismatch', 'Тип оплаты «Спеццена» требует спеццены в цене');
    }
    return { priceMode: 'rate' as const, discountPercent: null, specialNightly: null, priceReason: null, priceApprovedBy: null, paymentType: p.paymentType };
  }
  if (p.priceMode === 'discount') {
    requirePermission(ctx, 'booking.discount', 'Ручную скидку даёт администратор в пределах лимита');
    if (!p.discountPercent) throw badRequest('price.discount_required', 'Укажите размер скидки');
    if (!reason) throw badRequest('price.reason_required', 'Укажите причину скидки');
    const limit = ctx.property.settings.discountLimitPercent;
    if (p.discountPercent > limit && !can(ctx, 'booking.discount.unlimited')) {
      throw new AppError(403, 'price.discount_over_limit', `Скидка больше ${limit}% - только с управляющим`, undefined, { limit });
    }
    if (p.paymentType === 'special') throw badRequest('price.special_mismatch', 'Скидка и спеццена - разные режимы цены');
    return { priceMode: 'discount' as const, discountPercent: p.discountPercent, specialNightly: null, priceReason: reason, priceApprovedBy: null, paymentType: p.paymentType };
  }
  requirePermission(ctx, 'booking.special_price', 'Без права спеццену поставить нельзя');
  if (p.specialNightly == null) throw badRequest('price.special_required', 'Укажите спеццену за ночь');
  if (!reason || !ctx.property.settings.specialPriceBases.includes(reason)) {
    throw badRequest('price.basis_required', 'Выберите основание спеццены из списка', undefined, {
      bases: ctx.property.settings.specialPriceBases,
    });
  }
  if (!p.priceApprovedBy) throw badRequest('price.approver_required', 'Укажите, кто утвердил спеццену');
  const [approver] = await tx
    .select({ access: memberships.access, rights: memberships.rights, active: users.isActive, archivedAt: users.archivedAt })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.userId, p.priceApprovedBy), eq(memberships.propertyId, ctx.propertyId)));
  const approverRights = approver ? effectiveRights(approver.access as Access, cleanRights(approver.rights)) : null;
  if (!approver || !approver.active || approver.archivedAt || !approverRights!.powers.includes('special_price_approve')) {
    throw badRequest('price.approver_invalid', 'Утвердить спеццену может владелец, администратор или тот, кому дано это полномочие');
  }
  return {
    priceMode: 'special' as const,
    discountPercent: null,
    specialNightly: p.specialNightly,
    priceReason: reason,
    priceApprovedBy: p.priceApprovedBy,
    paymentType: 'special' as const,
  };
}

async function loadRoom(tx: DbOrTx, ctx: PropertyContext, roomId: string) {
  const [r] = await tx
    .select({ room: rooms, type: roomTypes })
    .from(rooms)
    .innerJoin(roomTypes, eq(roomTypes.id, rooms.roomTypeId))
    .where(and(eq(rooms.id, roomId), eq(rooms.propertyId, ctx.propertyId)));
  if (!r) throw notFound('room.not_found', 'Номер не найден');
  if (!r.room.isActive) throw conflict('room.inactive', `Номер ${r.room.number} выведен из продажи`);
  return r;
}

/** 409 с тем, что именно занимает номер: какая бронь или ремонт. */
export async function overlapError(db: Db, ctx: PropertyContext, roomId: string, arrival: string, departure: string, exceptBookingId?: string) {
  const conds: SQL[] = [
    eq(roomOccupancy.roomId, roomId),
    lt(roomOccupancy.startsOn, departure),
    gt(roomOccupancy.endsOn, arrival),
  ];
  if (exceptBookingId) conds.push(or(sql`${roomOccupancy.bookingId} is null`, ne(roomOccupancy.bookingId, exceptBookingId))!);
  const [occ] = await db
    .select({
      bookingId: roomOccupancy.bookingId,
      blockId: roomOccupancy.blockId,
      startsOn: roomOccupancy.startsOn,
      endsOn: roomOccupancy.endsOn,
      number: bookings.number,
      lastName: guests.lastName,
      firstName: guests.firstName,
      reason: roomBlocks.reason,
      roomNumber: rooms.number,
    })
    .from(roomOccupancy)
    .innerJoin(rooms, eq(rooms.id, roomOccupancy.roomId))
    .leftJoin(bookings, eq(bookings.id, roomOccupancy.bookingId))
    .leftJoin(guests, eq(guests.id, bookings.guestId))
    .leftJoin(roomBlocks, eq(roomBlocks.id, roomOccupancy.blockId))
    .where(and(...conds))
    .limit(1);
  if (!occ) return conflict('room.occupied', 'Номер уже занят на эти даты');
  if (occ.blockId) {
    return conflict('room.blocked', `Номер ${occ.roomNumber} заблокирован: ${occ.reason}`, `С ${occ.startsOn} по ${occ.endsOn}`, {
      conflict: { kind: 'block', id: occ.blockId, startsOn: occ.startsOn, endsOn: occ.endsOn, reason: occ.reason },
    });
  }
  return conflict(
    'room.occupied',
    `Номер ${occ.roomNumber} занят: бронь ${occ.number}, ${occ.lastName ?? ''} ${occ.firstName ?? ''}`.trim(),
    `Проживание с ${occ.startsOn} по ${occ.endsOn}`,
    { conflict: { kind: 'booking', id: occ.bookingId, number: occ.number, startsOn: occ.startsOn, endsOn: occ.endsOn } },
  );
}

/** Транзакция, в которой нарушение EXCLUDE превращается в понятный 409. */
async function withOverlapCheck<T>(
  deps: Deps,
  ctx: PropertyContext,
  probe: () => { roomId: string; arrival: string; departure: string; exceptBookingId?: string } | null,
  fn: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  try {
    return await deps.db.transaction(fn);
  } catch (err) {
    const p = probe();
    if (pgCode(err) === '23P01' && p) throw await overlapError(deps.db, ctx, p.roomId, p.arrival, p.departure, p.exceptBookingId);
    throw err;
  }
}

function validateDates(ctx: PropertyContext, arrival: string, departure: string, opts: { allowPastArrival?: boolean } = {}) {
  const nights = diffDays(arrival, departure);
  if (nights < 1) throw badRequest('booking.dates_invalid', 'Выезд должен быть позже заезда');
  if (nights > 90) throw badRequest('booking.too_long', 'Проживание длиннее 90 ночей оформляется частями');
  if (!opts.allowPastArrival && arrival < today(ctx)) {
    throw badRequest('booking.arrival_past', 'Дата заезда уже прошла');
  }
}

function defaultPrepayment(ctx: PropertyContext, arrival: string, nights: { amount: number }[], mealTotal: number, nightsCount: number) {
  const first = (nights[0]?.amount ?? 0) + (nightsCount ? Math.round(mealTotal / nightsCount) : 0);
  const dueByHours = new Date(Date.now() + ctx.property.settings.prepaymentHours * 3_600_000);
  const arrivalMoment = zonedToUtc(arrival, ctx.property.checkInTime, ctx.property.timezone);
  return { amount: first, dueAt: dueByHours < arrivalMoment ? dueByHours : arrivalMoment };
}

// ── Создание ───────────────────────────────────────────────────────────────

export async function createBooking(deps: Deps, ctx: PropertyContext, input: CreateBookingInputT): Promise<string> {
  validateDates(ctx, input.arrival, input.departure);
  if (input.status === 'confirmed') requirePermission(ctx, 'booking.confirm');

  return withOverlapCheck(
    deps,
    ctx,
    () => ({ roomId: input.roomId, arrival: input.arrival, departure: input.departure }),
    async (tx) => {
      const { room, type } = await loadRoom(tx, ctx, input.roomId);
      if (input.adults > type.maxOccupancy) {
        throw unprocessable('booking.too_many_guests', `В номере «${type.name}» до ${type.maxOccupancy} взрослых`);
      }
      const guest = await resolveGuest(tx, ctx, { guestId: input.guestId, guest: input.guest });
      if (guest.blacklisted) {
        if (!input.overrideBlacklist) {
          throw conflict('guest.blacklisted', 'Гость в чёрном списке', guest.blacklistReason ?? undefined, { guestId: guest.id });
        }
        requirePermission(ctx, 'guest.blacklist', 'Бронь гостю из чёрного списка оформляет старший администратор');
      }
      if (input.groupId) {
        const [g] = await tx.select().from(bookingGroups).where(and(eq(bookingGroups.id, input.groupId), eq(bookingGroups.propertyId, ctx.propertyId)));
        if (!g) throw notFound('group.not_found', 'Группа не найдена');
      }
      const price = await validatePrice(tx, ctx, input);
      const q = await quote(tx, ctx, {
        roomTypeId: type.id,
        ratePlanId: input.ratePlanId,
        arrival: input.arrival,
        departure: input.departure,
        adults: input.adults,
        meal: input.meal,
        priceMode: price.priceMode,
        discountPercent: price.discountPercent,
        specialNightly: price.specialNightly,
      });
      let prepaymentAmount: number | null = input.prepaymentAmount ?? null;
      let prepaymentDueAt: Date | null = input.prepaymentDueAt ? new Date(input.prepaymentDueAt) : null;
      if (input.status === 'tentative' && ctx.property.settings.autoCancelUnpaid) {
        const def = defaultPrepayment(ctx, input.arrival, q.nights, q.mealTotal, q.nights.length);
        prepaymentAmount ??= def.amount;
        prepaymentDueAt ??= def.dueAt;
      }
      if (input.status === 'confirmed') prepaymentDueAt = null;

      const id = newId();
      const number = await nextNumber(tx, ctx.propertyId, 'booking', 1001);
      const now = new Date();
      await tx.insert(bookings).values({
        id,
        propertyId: ctx.propertyId,
        number,
        status: input.status,
        guestId: guest.id,
        companyId: input.companyId ?? guest.companyId ?? null,
        groupId: input.groupId ?? null,
        roomTypeId: type.id,
        roomId: room.id,
        arrival: input.arrival,
        departure: input.departure,
        adults: input.adults,
        children: input.children,
        ratePlanId: input.ratePlanId,
        meal: input.meal,
        source: input.source,
        ...price,
        nights: q.nights,
        baseTotal: q.baseTotal,
        accommodationTotal: q.accommodationTotal,
        mealTotal: q.mealTotal,
        prepaymentAmount,
        prepaymentDueAt,
        comment: trimOrNull(input.comment),
        externalRef: trimOrNull(input.externalRef),
        createdAt: now,
        createdBy: ctx.actor.id,
        updatedAt: now,
        updatedBy: ctx.actor.id,
      });
      await audit(tx, ctx, {
        action: 'booking.create',
        entityType: 'booking',
        entityId: id,
        entityLabel: `Бронь ${number}`,
        changes: {
          status: [null, STATUS_LABEL[input.status]],
          guest: [null, fullName(guest)],
          room: [null, room.number],
          dates: [null, `${input.arrival} - ${input.departure}`],
          total: [null, q.total],
          ...(price.priceMode !== 'rate' ? { price: [null, `${price.priceMode}: ${price.priceReason}`] } : {}),
        },
        reason: price.priceReason,
      });
      await emit(tx, ctx, 'booking.changed', id, { roomId: room.id });
      return id;
    },
  );
}

// ── Изменение: даты, номер, тариф, цена ─────────────────────────────────────

export async function updateBooking(deps: Deps, ctx: PropertyContext, id: string, input: UpdateBookingInputT, version: number | null) {
  let probe: { roomId: string; arrival: string; departure: string; exceptBookingId: string } | null = null;
  return withOverlapCheck(
    deps,
    ctx,
    () => probe,
    async (tx) => {
      const before = await loadBooking(tx, ctx, id, true);
      checkVersion(before, version);
      if (before.status === 'cancelled' || before.status === 'no_show') {
        throw conflict('booking.closed', `Бронь ${STATUS_LABEL[before.status].toLowerCase()}: изменить нельзя`);
      }
      const touchesStay =
        input.roomId !== undefined || input.arrival !== undefined || input.departure !== undefined ||
        input.ratePlanId !== undefined || input.priceMode !== undefined || input.meal !== undefined ||
        input.adults !== undefined || input.discountPercent !== undefined || input.specialNightly !== undefined;
      if (before.status === 'checked_out' && (touchesStay || input.guestId || input.paymentType)) {
        throw conflict('booking.closed', 'Гость выселен: менять проживание нельзя, только комментарий');
      }
      requirePermission(ctx, 'booking.edit');

      const arrival = input.arrival ?? before.arrival;
      const departure = input.departure ?? before.departure;
      if (before.status === 'checked_in' && arrival !== before.arrival) {
        throw conflict('booking.in_house_arrival', 'Гость уже заселён: дату заезда не меняют');
      }
      if (arrival !== before.arrival || departure !== before.departure) {
        validateDates(ctx, arrival, departure, { allowPastArrival: arrival === before.arrival });
        if (before.status === 'checked_in' && departure <= today(ctx) && departure !== before.departure) {
          throw badRequest('booking.departure_past', 'Дата выезда не может быть раньше сегодняшней');
        }
      }

      const roomId = input.roomId ?? before.roomId;
      const { room, type } = await loadRoom(tx, ctx, roomId);
      const roomChanged = roomId !== before.roomId;
      if (roomChanged && before.status === 'checked_in' && room.hkStatus !== 'inspected' && !input.overrideRoomStatus) {
        throw conflict('room.not_ready', `Номер ${room.number} не проверен хозслужбой`, 'Переселение в него - только осознанно, с отметкой.', {
          hkStatus: room.hkStatus,
        });
      }
      const adults = input.adults ?? before.adults;
      if (adults > type.maxOccupancy) {
        throw unprocessable('booking.too_many_guests', `В номере «${type.name}» до ${type.maxOccupancy} взрослых`);
      }

      const priceTouched =
        input.priceMode !== undefined || input.discountPercent !== undefined || input.specialNightly !== undefined ||
        input.priceReason !== undefined || input.priceApprovedBy !== undefined || input.paymentType !== undefined;
      const price = priceTouched
        ? await validatePrice(tx, ctx, {
            priceMode: input.priceMode ?? before.priceMode,
            discountPercent: input.discountPercent !== undefined ? input.discountPercent : before.discountPercent,
            specialNightly: input.specialNightly !== undefined ? input.specialNightly : before.specialNightly,
            priceReason: input.priceReason !== undefined ? input.priceReason : before.priceReason,
            priceApprovedBy: input.priceApprovedBy !== undefined ? input.priceApprovedBy : before.priceApprovedBy,
            paymentType: input.paymentType ?? before.paymentType,
          })
        : {
            priceMode: before.priceMode,
            discountPercent: before.discountPercent,
            specialNightly: before.specialNightly,
            priceReason: before.priceReason,
            priceApprovedBy: before.priceApprovedBy,
            paymentType: before.paymentType,
          };

      const ratePlanId = input.ratePlanId ?? before.ratePlanId;
      const meal = input.meal ?? before.meal;
      const fullReprice =
        input.reprice === 'all' || priceTouched || ratePlanId !== before.ratePlanId || type.id !== before.roomTypeId;
      const keepNights = fullReprice ? [] : before.nights.filter((n) => n.date >= arrival && n.date < departure);
      const needQuote = fullReprice || arrival !== before.arrival || departure !== before.departure || meal !== before.meal || adults !== before.adults;
      const q = needQuote
        ? await quote(tx, ctx, {
            roomTypeId: type.id,
            ratePlanId,
            arrival,
            departure,
            adults,
            meal,
            priceMode: price.priceMode,
            discountPercent: price.discountPercent,
            specialNightly: price.specialNightly,
            keepNights,
          })
        : null;

      if (input.guestId && input.guestId !== before.guestId) {
        await resolveGuest(tx, ctx, { guestId: input.guestId });
      }

      probe = { roomId, arrival, departure, exceptBookingId: before.id };
      const [after] = await tx
        .update(bookings)
        .set({
          guestId: input.guestId ?? before.guestId,
          companyId: input.companyId !== undefined ? input.companyId : before.companyId,
          groupId: input.groupId !== undefined ? input.groupId : before.groupId,
          roomId,
          roomTypeId: type.id,
          arrival,
          departure,
          adults,
          children: input.children ?? before.children,
          ratePlanId,
          meal,
          source: input.source ?? before.source,
          ...price,
          ...(q
            ? { nights: q.nights, baseTotal: q.baseTotal, accommodationTotal: q.accommodationTotal, mealTotal: q.mealTotal }
            : {}),
          prepaymentAmount: input.prepaymentAmount !== undefined ? input.prepaymentAmount : before.prepaymentAmount,
          prepaymentDueAt:
            input.prepaymentDueAt !== undefined ? (input.prepaymentDueAt ? new Date(input.prepaymentDueAt) : null) : before.prepaymentDueAt,
          comment: input.comment !== undefined ? trimOrNull(input.comment) : before.comment,
          externalRef: input.externalRef !== undefined ? trimOrNull(input.externalRef) : before.externalRef,
          updatedAt: new Date(),
          updatedBy: ctx.actor.id,
          version: before.version + 1,
        })
        .where(eq(bookings.id, before.id))
        .returning();

      // Переселение живущего гостя: старый номер уходит в уборку.
      if (roomChanged && before.status === 'checked_in') {
        await markRoomForCleaning(tx, ctx, before.roomId, 'departure', `Переселение гостя из номера (бронь ${before.number})`);
      }

      const action = roomChanged ? 'booking.move' : arrival !== before.arrival || departure !== before.departure ? 'booking.dates' : 'booking.update';
      await audit(tx, ctx, {
        action,
        entityType: 'booking',
        entityId: before.id,
        entityLabel: `Бронь ${before.number}`,
        before: { ...before, nights: undefined } as Record<string, unknown>,
        after: { ...after!, nights: undefined } as Record<string, unknown>,
        reason: price.priceMode !== 'rate' ? price.priceReason : null,
      });
      await emit(tx, ctx, 'booking.changed', before.id, { roomId, previousRoomId: roomChanged ? before.roomId : undefined });
      return before.id;
    },
  );
}

// ── Статусы ────────────────────────────────────────────────────────────────

export async function confirmBooking(deps: Deps, ctx: PropertyContext, id: string, version: number | null) {
  return deps.db.transaction(async (tx) => {
    const b = await loadBooking(tx, ctx, id, true);
    checkVersion(b, version);
    if (b.status !== 'tentative') throw conflict('booking.status', `Подтвердить можно только предварительную бронь, сейчас - «${STATUS_LABEL[b.status]}»`);
    await setStatus(tx, ctx, b, 'confirmed', { prepaymentDueAt: null });
    return b.id;
  });
}

async function setStatus(tx: DbOrTx, ctx: PropertyContext, b: BookingRow, status: Status, extra: Partial<typeof bookings.$inferInsert> = {}, reason?: string | null) {
  await tx
    .update(bookings)
    .set({ status, ...extra, updatedAt: new Date(), updatedBy: ctx.actor.id, version: b.version + 1 })
    .where(eq(bookings.id, b.id));
  await audit(tx, ctx, {
    action: `booking.${status}`,
    entityType: 'booking',
    entityId: b.id,
    entityLabel: `Бронь ${b.number}`,
    changes: { status: [STATUS_LABEL[b.status], STATUS_LABEL[status]] },
    reason: reason ?? null,
  });
  await emit(tx, ctx, 'booking.changed', b.id, { roomId: b.roomId, status });
}

export async function cancelBooking(deps: Deps, ctx: PropertyContext, id: string, reason: string, version: number | null) {
  const why = trimOrNull(reason);
  if (!why) throw badRequest('booking.reason_required', 'Укажите причину отмены');
  return deps.db.transaction(async (tx) => {
    const b = await loadBooking(tx, ctx, id, true);
    checkVersion(b, version);
    if (b.status !== 'tentative' && b.status !== 'confirmed') {
      throw conflict('booking.status', `Отменить можно бронь до заселения, сейчас - «${STATUS_LABEL[b.status]}»`);
    }
    await setStatus(tx, ctx, b, 'cancelled', { cancelReason: why, cancelledAt: new Date(), cancelledBy: ctx.actor.id, prepaymentDueAt: null }, why);
    return b.id;
  });
}

export async function noShowBooking(deps: Deps, ctx: PropertyContext, id: string, reason: string, version: number | null) {
  const why = trimOrNull(reason);
  if (!why) throw badRequest('booking.reason_required', 'Укажите причину незаезда');
  return deps.db.transaction(async (tx) => {
    const b = await loadBooking(tx, ctx, id, true);
    checkVersion(b, version);
    if (b.status !== 'tentative' && b.status !== 'confirmed') {
      throw conflict('booking.status', `Незаезд отмечают до заселения, сейчас - «${STATUS_LABEL[b.status]}»`);
    }
    if (b.arrival > today(ctx)) throw conflict('booking.no_show_early', 'Дата заезда ещё не наступила');
    await setStatus(tx, ctx, b, 'no_show', { cancelReason: why, cancelledAt: new Date(), cancelledBy: ctx.actor.id, prepaymentDueAt: null }, why);
    return b.id;
  });
}

export type Problem = { code: string; message: string; blocking: boolean };

/** Что мешает заселить гостя прямо сейчас. Мастер заселения показывает это списком. */
export async function checkInProblems(tx: DbOrTx, ctx: PropertyContext, b: BookingRow): Promise<Problem[]> {
  const problems: Problem[] = [];
  const day = today(ctx);
  if (b.status !== 'tentative' && b.status !== 'confirmed') {
    problems.push({ code: 'booking.status', message: `Бронь в статусе «${STATUS_LABEL[b.status]}»`, blocking: true });
    return problems;
  }
  if (b.arrival > day) {
    problems.push({ code: 'booking.early', message: `Заезд по брони ${b.arrival}. Для раннего заезда сначала перенесите дату заезда`, blocking: true });
  }
  if (b.departure <= day) {
    problems.push({ code: 'booking.departure_passed', message: 'Дата выезда уже наступила', blocking: true });
  }
  const [room] = await tx.select().from(rooms).where(eq(rooms.id, b.roomId));
  if (room && room.hkStatus !== 'inspected' && ctx.property.settings.requireInspectedForCheckIn) {
    const label = { dirty: 'грязный', cleaning: 'в уборке', clean: 'убран, не проверен', repair: 'на ремонте', inspected: 'проверен' }[room.hkStatus];
    problems.push({ code: 'room.not_ready', message: `Номер ${room.number}: ${label}. Продать можно только проверенный номер`, blocking: true });
  }
  const [g] = await tx.select().from(guests).where(eq(guests.id, b.guestId));
  if (g) {
    const missing: string[] = [];
    if (!g.docType || !g.docNumber) missing.push('документ');
    if (!g.birthDate) missing.push('дата рождения');
    if (!g.citizenship) missing.push('гражданство');
    if (missing.length) problems.push({ code: 'guest.data_missing', message: `В карточке гостя нет: ${missing.join(', ')}`, blocking: true });
    if (!g.pdConsentAt) {
      problems.push({ code: 'guest.consent_missing', message: 'Нет согласия на обработку персональных данных и правил проживания', blocking: true });
    }
    if (g.docExpiresOn && g.docExpiresOn < day) {
      problems.push({ code: 'guest.document_expired', message: `Документ гостя просрочен (${g.docExpiresOn})`, blocking: false });
    }
    if (g.blacklisted) {
      problems.push({ code: 'guest.blacklisted', message: `Гость в чёрном списке: ${g.blacklistReason ?? 'без причины'}`, blocking: !can(ctx, 'guest.blacklist') });
    }
  }
  return problems;
}

export async function checkIn(deps: Deps, ctx: PropertyContext, id: string, opts: { keyIssued: boolean; version: number | null }) {
  return deps.db.transaction(async (tx) => {
    const b = await loadBooking(tx, ctx, id, true);
    checkVersion(b, opts.version);
    const blocking = (await checkInProblems(tx, ctx, b)).filter((p) => p.blocking);
    if (blocking.length) {
      throw conflict('checkin.not_ready', 'Заселить пока нельзя', blocking.map((p) => p.message).join('. '), { problems: blocking });
    }
    const now = new Date();
    await setStatus(tx, ctx, b, 'checked_in', {
      checkedInAt: now,
      checkedInBy: ctx.actor.id,
      keyIssuedAt: opts.keyIssued ? now : null,
      prepaymentDueAt: null,
    });
    await emit(tx, ctx, 'room.changed', b.roomId);
    return b.id;
  });
}

export async function checkOut(
  deps: Deps,
  ctx: PropertyContext,
  id: string,
  opts: { rating?: number | null | undefined; feedback?: string | null | undefined; allowDebt: boolean; debtReason?: string | null | undefined; version: number | null },
) {
  return deps.db.transaction(async (tx) => {
    const b = await loadBooking(tx, ctx, id, true);
    checkVersion(b, opts.version);
    if (b.status !== 'checked_in') throw conflict('booking.status', `Выселить можно заселённого гостя, сейчас - «${STATUS_LABEL[b.status]}»`);
    const day = today(ctx);
    if (b.departure > day) {
      throw conflict('checkout.early', `Выезд по брони ${b.departure}. При раннем выезде сначала сократите проживание: цена пересчитается`, undefined, {
        departure: b.departure,
      });
    }
    if (b.departure < day) {
      throw conflict('checkout.overstay', `Выезд по брони был ${b.departure}. Продлите проживание до сегодняшней даты`);
    }
    const bal = await balanceOf(tx, b.id);
    if (bal.deposit > 0) {
      throw conflict('checkout.deposit_held', 'У гостя на руках депозит: верните его или зачтите в оплату', undefined, { balance: bal });
    }
    if (bal.due < 0) {
      throw conflict('checkout.overpaid', 'Переплата: оформите возврат разницы гостю', undefined, { balance: bal });
    }
    if (bal.due > 0) {
      if (!opts.allowDebt) {
        throw conflict('checkout.unpaid', 'Счёт не оплачен полностью', undefined, { balance: bal });
      }
      requirePermission(ctx, 'booking.checkout_debt', 'Выселить с долгом может старший администратор или управляющий');
      if (!trimOrNull(opts.debtReason)) throw badRequest('checkout.debt_reason', 'Укажите, кто и как закроет долг');
    }
    const now = new Date();
    await setStatus(
      tx,
      ctx,
      b,
      'checked_out',
      { checkedOutAt: now, checkedOutBy: ctx.actor.id, rating: opts.rating ?? null, feedback: trimOrNull(opts.feedback) },
      bal.due > 0 ? `Выселен с долгом ${bal.due}: ${opts.debtReason}` : null,
    );
    await markRoomForCleaning(tx, ctx, b.roomId, 'departure', `Выезд гостя (бронь ${b.number})`);
    return b.id;
  });
}

/** Номер «грязный» и задача горничной: при выезде и при переселении. */
export async function markRoomForCleaning(tx: DbOrTx, ctx: PropertyContext, roomId: string, kind: 'departure' | 'stayover', note: string) {
  const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).for('update');
  if (!room) return;
  const now = new Date();
  if (room.hkStatus !== 'repair') {
    await tx
      .update(rooms)
      .set({ hkStatus: 'dirty', hkStatusAt: now, hkStatusBy: ctx.actor.id, dnd: false, version: room.version + 1 })
      .where(eq(rooms.id, room.id));
    await audit(tx, ctx, {
      action: 'room.hk_status',
      entityType: 'room',
      entityId: room.id,
      entityLabel: `Номер ${room.number}`,
      changes: { hkStatus: [room.hkStatus, 'dirty'] },
      reason: note,
    });
  }
  const day = today(ctx);
  const [open] = await tx
    .select({ id: hkTasks.id })
    .from(hkTasks)
    .where(and(eq(hkTasks.roomId, room.id), eq(hkTasks.businessDate, day), inArray(hkTasks.status, ['open', 'in_progress']), eq(hkTasks.kind, kind)));
  if (!open) {
    const dueAt = zonedToUtc(day, ctx.property.checkInTime, ctx.property.timezone);
    const taskId = newId();
    await tx.insert(hkTasks).values({
      id: taskId,
      propertyId: ctx.propertyId,
      roomId: room.id,
      kind,
      businessDate: day,
      dueAt,
      note,
      checklist: kind === 'departure' ? DEPARTURE_CHECKLIST.map((text) => ({ text, done: false })) : [],
      createdBy: ctx.actor.id,
    });
    await emit(tx, ctx, 'hk.task.changed', taskId, { roomId: room.id });
  }
  await emit(tx, ctx, 'room.changed', room.id);
}

export const DEPARTURE_CHECKLIST = [
  'Сменить постельное бельё и полотенца',
  'Санузел: сантехника, зеркала, пол',
  'Пыль, поверхности, пол в комнате',
  'Мини-бар: проверить и пополнить',
  'Расходники: вода, мыло, бумага',
  'Проверить исправность: свет, кондиционер, ТВ',
];

export async function checkInReadiness(deps: Deps, ctx: PropertyContext, id: string) {
  const b = await loadBooking(deps.db, ctx, id);
  const problems = await checkInProblems(deps.db, ctx, b);
  const bal = can(ctx, 'folio.view') ? await balanceOf(deps.db, b.id) : null;
  return { ready: !problems.some((p) => p.blocking), problems, balance: bal };
}

// ── Списки и шахматка ──────────────────────────────────────────────────────

export async function listBookings(
  db: DbOrTx,
  ctx: PropertyContext,
  q: {
    view?: 'arrivals' | 'departures' | 'inhouse' | 'all' | undefined;
    date?: string | undefined;
    status?: Status[] | undefined;
    q?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    guestId?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  },
) {
  const day = q.date ?? today(ctx);
  const conds: SQL[] = [eq(bookings.propertyId, ctx.propertyId)];
  let order: SQL[] = [desc(bookings.arrival), desc(bookings.number)];
  let paged = true;
  if (q.view === 'arrivals') {
    conds.push(eq(bookings.arrival, day), inArray(bookings.status, ['tentative', 'confirmed', 'checked_in']));
    order = [asc(rooms.sort), asc(rooms.number)];
    paged = false;
  } else if (q.view === 'departures') {
    conds.push(eq(bookings.departure, day), inArray(bookings.status, ['checked_in', 'checked_out']));
    order = [asc(rooms.sort), asc(rooms.number)];
    paged = false;
  } else if (q.view === 'inhouse') {
    conds.push(eq(bookings.status, 'checked_in'));
    order = [asc(rooms.sort), asc(rooms.number)];
    paged = false;
  }
  if (q.status?.length) conds.push(inArray(bookings.status, q.status));
  if (q.from) conds.push(gt(bookings.departure, q.from));
  if (q.to) conds.push(lte(bookings.arrival, q.to));
  if (q.guestId) conds.push(eq(bookings.guestId, q.guestId));
  const term = q.q?.trim();
  if (term) {
    const parts: SQL[] = [
      sql`lower(${guests.lastName} || ' ' || ${guests.firstName}) like ${'%' + term.toLowerCase() + '%'}`,
      sql`${guests.phoneNorm} like ${'%' + term.replace(/\D+/g, '') + '%'}`,
    ];
    if (/^\d+$/.test(term)) parts.push(eq(bookings.number, Number(term)));
    if (!term.replace(/\D+/g, '')) parts.splice(1, 1);
    conds.push(or(...parts)!);
  }
  if (paged) {
    const cursor = decodeCursor<[string, number]>(q.cursor);
    if (cursor) conds.push(sql`(${bookings.arrival}, ${bookings.number}) < (${cursor[0]}, ${cursor[1]})`);
  }
  const rows = await db
    .select({ b: bookings, g: guests, roomNumber: rooms.number, roomHk: rooms.hkStatus, typeName: roomTypes.name })
    .from(bookings)
    .innerJoin(guests, eq(guests.id, bookings.guestId))
    .innerJoin(rooms, eq(rooms.id, bookings.roomId))
    .innerJoin(roomTypes, eq(roomTypes.id, bookings.roomTypeId))
    .where(and(...conds))
    .orderBy(...order)
    .limit(paged ? q.limit + 1 : 500);
  const page = paged ? pageOf(rows, q.limit, (r) => [r.b.arrival, r.b.number]) : { items: rows, nextCursor: null };
  const showMoney = can(ctx, 'folio.view');
  const bal = showMoney ? await balances(db, page.items.map((r) => r.b.id)) : new Map<string, Balance>();
  return {
    items: page.items.map((r) => listItem(r.b, r.g, r.roomNumber, r.roomHk, r.typeName, showMoney ? (bal.get(r.b.id) ?? null) : null)),
    nextCursor: page.nextCursor,
  };
}

export function listItem(
  b: BookingRow,
  g: typeof guests.$inferSelect,
  roomNumber: string,
  roomHk: (typeof rooms.$inferSelect)['hkStatus'],
  typeName: string,
  bal: Balance | null,
) {
  return {
    id: b.id,
    number: b.number,
    status: b.status,
    guestId: g.id,
    guestName: fullName(g),
    isVip: g.isVip,
    roomId: b.roomId,
    roomNumber,
    roomTypeName: typeName,
    arrival: b.arrival,
    departure: b.departure,
    adults: b.adults,
    children: b.children,
    source: b.source,
    paymentType: b.paymentType,
    total: bal ? bal.charges : null,
    due: bal ? bal.due : null,
    roomHkStatus: roomHk,
    prepaymentOverdue: isPrepaymentOverdue(b, bal ?? undefined),
    createdAt: b.createdAt.toISOString(),
  };
}

export async function tapeChart(db: DbOrTx, ctx: PropertyContext, from: string, to: string) {
  const span = diffDays(from, to);
  if (span < 1 || span > 93) throw badRequest('tape.range', 'Период шахматки - от 1 до 93 дней');
  const types = await db.select().from(roomTypes).where(eq(roomTypes.propertyId, ctx.propertyId)).orderBy(asc(roomTypes.sort));
  const roomRows = await db.select().from(rooms).where(eq(rooms.propertyId, ctx.propertyId)).orderBy(asc(rooms.sort), asc(rooms.number));
  const rows = await db
    .select({ b: bookings, g: guests })
    .from(bookings)
    .innerJoin(guests, eq(guests.id, bookings.guestId))
    .where(
      and(
        eq(bookings.propertyId, ctx.propertyId),
        inArray(bookings.status, ['tentative', 'confirmed', 'checked_in', 'checked_out']),
        lt(bookings.arrival, to),
        gt(bookings.departure, from),
      ),
    );
  const blocks = await db
    .select()
    .from(roomBlocks)
    .where(and(eq(roomBlocks.propertyId, ctx.propertyId), eq(roomBlocks.isActive, true), lt(roomBlocks.startsOn, to), gt(roomBlocks.endsOn, from)));
  const showMoney = can(ctx, 'folio.view');
  const showGuests = can(ctx, 'guest.view') || can(ctx, 'booking.view');
  const bal = showMoney ? await balances(db, rows.map((r) => r.b.id)) : new Map<string, Balance>();

  const activeRooms = roomRows.filter((r) => r.isActive).length;
  const days = eachNight(from, to).map((date) => {
    const occupied = rows.filter((r) => r.b.arrival <= date && r.b.departure > date).length;
    const blocked = blocks.filter((k) => k.startsOn <= date && k.endsOn > date).length;
    return { date, occupied, available: Math.max(0, activeRooms - blocked) };
  });

  return {
    from,
    to,
    businessDate: today(ctx),
    roomTypes: types.map((t) => ({ id: t.id, code: t.code, name: t.name, sort: t.sort })),
    rooms: roomRows.map((r) => ({ id: r.id, number: r.number, roomTypeId: r.roomTypeId, floor: r.floor, hkStatus: r.hkStatus, dnd: r.dnd, isActive: r.isActive })),
    bookings: rows.map(({ b, g }) => {
      const balance = bal.get(b.id);
      return {
        id: b.id,
        number: b.number,
        status: b.status,
        roomId: b.roomId,
        arrival: b.arrival,
        departure: b.departure,
        guestName: showGuests ? fullName(g) : `Бронь ${b.number}`,
        isVip: g.isVip,
        adults: b.adults,
        children: b.children,
        paymentType: b.paymentType,
        source: b.source,
        groupId: b.groupId,
        hasComment: !!b.comment,
        due: showMoney ? (balance?.due ?? 0) : null,
        prepaymentOverdue: isPrepaymentOverdue(b, balance),
        version: b.version,
      };
    }),
    blocks: blocks.map((k) => ({ id: k.id, roomId: k.roomId, startsOn: k.startsOn, endsOn: k.endsOn, reason: k.reason })),
    days,
  };
}

// ── Блокировки номеров ─────────────────────────────────────────────────────

export async function createBlock(
  deps: Deps,
  ctx: PropertyContext,
  input: { roomId: string; startsOn: string; endsOn: string; reason: string; maintenanceRequestId?: string | null },
  tx0?: DbOrTx,
) {
  if (diffDays(input.startsOn, input.endsOn) < 1) throw badRequest('block.dates_invalid', 'Блокировка - минимум на одни сутки');
  const run = async (tx: DbOrTx) => {
    const { room } = await loadRoom(tx, ctx, input.roomId);
    const id = newId();
    await tx.insert(roomBlocks).values({
      id,
      propertyId: ctx.propertyId,
      roomId: room.id,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      reason: input.reason,
      maintenanceRequestId: input.maintenanceRequestId ?? null,
      createdBy: ctx.actor.id,
    });
    if (input.startsOn <= today(ctx) && input.endsOn > today(ctx) && room.hkStatus !== 'repair') {
      await tx
        .update(rooms)
        .set({ hkStatus: 'repair', hkStatusAt: new Date(), hkStatusBy: ctx.actor.id, version: room.version + 1 })
        .where(eq(rooms.id, room.id));
    }
    await audit(tx, ctx, {
      action: 'room.block',
      entityType: 'room',
      entityId: room.id,
      entityLabel: `Номер ${room.number}`,
      changes: { block: [null, `${input.startsOn} - ${input.endsOn}`] },
      reason: input.reason,
    });
    await emit(tx, ctx, 'room.changed', room.id);
    return id;
  };
  if (tx0) return run(tx0);
  try {
    return await deps.db.transaction(run);
  } catch (err) {
    if (pgCode(err) === '23P01') throw await overlapError(deps.db, ctx, input.roomId, input.startsOn, input.endsOn);
    throw err;
  }
}

export async function releaseBlock(tx: DbOrTx, ctx: PropertyContext, blockId: string, note: string) {
  const [block] = await tx
    .select()
    .from(roomBlocks)
    .where(and(eq(roomBlocks.id, blockId), eq(roomBlocks.propertyId, ctx.propertyId)))
    .for('update');
  if (!block) throw notFound('block.not_found', 'Блокировка не найдена');
  if (!block.isActive) return block;
  await tx.update(roomBlocks).set({ isActive: false, releasedAt: new Date(), releasedBy: ctx.actor.id }).where(eq(roomBlocks.id, block.id));
  const [room] = await tx.select().from(rooms).where(eq(rooms.id, block.roomId)).for('update');
  if (room && room.hkStatus === 'repair') {
    // После ремонта номер возвращается в уборку, а уже из неё - в продажу.
    await tx
      .update(rooms)
      .set({ hkStatus: 'dirty', hkStatusAt: new Date(), hkStatusBy: ctx.actor.id, version: room.version + 1 })
      .where(eq(rooms.id, room.id));
  }
  await audit(tx, ctx, {
    action: 'room.unblock',
    entityType: 'room',
    entityId: block.roomId,
    entityLabel: room ? `Номер ${room.number}` : undefined,
    changes: { block: [`${block.startsOn} - ${block.endsOn}`, null] },
    reason: note,
  });
  await emit(tx, ctx, 'room.changed', block.roomId);
  return block;
}

// ── Группы ─────────────────────────────────────────────────────────────────

export async function createGroup(
  deps: Deps,
  ctx: PropertyContext,
  input: { name: string; companyId?: string | null | undefined; billing: 'single' | 'split'; comment?: string | null | undefined },
) {
  return deps.db.transaction(async (tx) => {
    const id = newId();
    await tx.insert(bookingGroups).values({
      id,
      propertyId: ctx.propertyId,
      name: input.name,
      companyId: input.companyId ?? null,
      billing: input.billing,
      comment: trimOrNull(input.comment),
      createdBy: ctx.actor.id,
    });
    await audit(tx, ctx, { action: 'group.create', entityType: 'group', entityId: id, entityLabel: input.name, after: input });
    return id;
  });
}

export async function groupDto(db: DbOrTx, ctx: PropertyContext, id: string) {
  const [g] = await db
    .select({ g: bookingGroups, companyName: companies.name })
    .from(bookingGroups)
    .leftJoin(companies, eq(companies.id, bookingGroups.companyId))
    .where(and(eq(bookingGroups.id, id), eq(bookingGroups.propertyId, ctx.propertyId)));
  if (!g) throw notFound('group.not_found', 'Группа не найдена');
  const rows = await db
    .select({ b: bookings, g: guests, roomNumber: rooms.number, roomHk: rooms.hkStatus, typeName: roomTypes.name })
    .from(bookings)
    .innerJoin(guests, eq(guests.id, bookings.guestId))
    .innerJoin(rooms, eq(rooms.id, bookings.roomId))
    .innerJoin(roomTypes, eq(roomTypes.id, bookings.roomTypeId))
    .where(eq(bookings.groupId, id))
    .orderBy(asc(rooms.number));
  const showMoney = can(ctx, 'folio.view');
  const bal = showMoney ? await balances(db, rows.map((r) => r.b.id)) : new Map<string, Balance>();
  return {
    id: g.g.id,
    name: g.g.name,
    companyId: g.g.companyId,
    companyName: g.companyName,
    billing: g.g.billing,
    comment: g.g.comment,
    bookings: rows.map((r) => listItem(r.b, r.g, r.roomNumber, r.roomHk, r.typeName, showMoney ? (bal.get(r.b.id) ?? null) : null)),
    version: g.g.version,
  };
}

export { ACTIVE };
