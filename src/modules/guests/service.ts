import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { audit, emit } from '../../core/audit.ts';
import type { PropertyContext } from '../../core/context.ts';
import { can, requirePermission } from '../../core/context.ts';
import { iso } from '../../core/http.ts';
import type { DbOrTx } from '../../db/client.ts';
import { bookings, companies, guestDocuments, guests, properties, rooms, roomTypes } from '../../db/schema/index.ts';
import { badRequest, conflict, notFound, preconditionFailed } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { fullName, normalizeDocNumber, normalizeEmail, normalizePhone, trimOrNull } from '../../lib/normalize.ts';
import { decodeCursor, pageOf } from '../../lib/pagination.ts';
import type { GuestInputT } from './schemas.ts';

type GuestRow = typeof guests.$inferSelect;

const nameExpr = sql`lower(${guests.lastName} || ' ' || ${guests.firstName} || ' ' || coalesce(${guests.middleName}, ''))`;

export type GuestStats = { stays: number; nights: number; spent: number; lastStay: string | null; cancellations: number; noShows: number };
const EMPTY_STATS: GuestStats = { stays: 0, nights: 0, spent: 0, lastStay: null, cancellations: 0, noShows: 0 };

export async function guestStats(tx: DbOrTx, guestIds: string[]): Promise<Map<string, GuestStats>> {
  const out = new Map<string, GuestStats>();
  if (!guestIds.length) return out;
  const rows = await tx.execute<{
    guest_id: string;
    stays: string;
    nights: string;
    spent: string;
    last_stay: string | null;
    cancellations: string;
    no_shows: string;
  }>(sql`
    select b.guest_id,
      count(*) filter (where b.status in ('checked_in','checked_out')) as stays,
      coalesce(sum(b.departure - b.arrival) filter (where b.status in ('checked_in','checked_out')), 0) as nights,
      coalesce(sum(b.accommodation_total + b.meal_total + coalesce(f.items, 0)) filter (where b.status in ('checked_in','checked_out')), 0) as spent,
      max(b.arrival) filter (where b.status in ('checked_in','checked_out'))::text as last_stay,
      count(*) filter (where b.status = 'cancelled') as cancellations,
      count(*) filter (where b.status = 'no_show') as no_shows
    from bookings b
    left join lateral (select sum(amount) as items from folio_items fi where fi.booking_id = b.id) f on true
    where b.guest_id in (${sql.join(guestIds.map((id) => sql`${id}`), sql`, `)})
    group by b.guest_id
  `);
  for (const r of rows) {
    out.set(r.guest_id, {
      stays: Number(r.stays),
      nights: Number(r.nights),
      spent: Number(r.spent),
      lastStay: r.last_stay,
      cancellations: Number(r.cancellations),
      noShows: Number(r.no_shows),
    });
  }
  return out;
}

async function companyNames(tx: DbOrTx, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (!unique.length) return new Map();
  const rows = await tx.select({ id: companies.id, name: companies.name }).from(companies).where(inArray(companies.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export function guestDto(g: GuestRow, stats: GuestStats, companyName: string | null) {
  return {
    id: g.id,
    lastName: g.lastName,
    firstName: g.firstName,
    middleName: g.middleName,
    fullName: fullName(g),
    birthDate: g.birthDate,
    gender: g.gender,
    citizenship: g.citizenship,
    docType: g.docType,
    docNumber: g.docNumber,
    docIssuedBy: g.docIssuedBy,
    docIssuedOn: g.docIssuedOn,
    docExpiresOn: g.docExpiresOn,
    personalNumber: g.personalNumber,
    address: g.address,
    phone: g.phone,
    email: g.email,
    language: g.language,
    companyId: g.companyId,
    companyName,
    isVip: g.isVip,
    blacklisted: g.blacklisted,
    blacklistReason: g.blacklistReason,
    preferences: g.preferences,
    notes: g.notes,
    marketingConsent: g.marketingConsent,
    pdConsentAt: iso(g.pdConsentAt),
    pdConsentMethod: g.pdConsentMethod,
    mergedInto: g.mergedInto,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
    version: g.version,
    stats,
  };
}

export function listItemDto(g: GuestRow, stats: GuestStats, companyName: string | null) {
  return {
    id: g.id,
    fullName: fullName(g),
    phone: g.phone,
    email: g.email,
    citizenship: g.citizenship,
    birthDate: g.birthDate,
    docNumber: g.docNumber,
    companyName,
    isVip: g.isVip,
    blacklisted: g.blacklisted,
    stays: stats.stays,
    lastStay: stats.lastStay,
  };
}

export async function loadGuest(tx: DbOrTx, ctx: PropertyContext, id: string, opts: { forUpdate?: boolean } = {}): Promise<GuestRow> {
  const q = tx.select().from(guests).where(and(eq(guests.id, id), eq(guests.orgId, ctx.orgId)));
  const [row] = opts.forUpdate ? await q.for('update') : await q;
  if (!row) throw notFound('guest.not_found', 'Гость не найден');
  return row;
}

export async function getGuest(tx: DbOrTx, ctx: PropertyContext, id: string) {
  const g = await loadGuest(tx, ctx, id);
  const stats = (await guestStats(tx, [g.id])).get(g.id) ?? EMPTY_STATS;
  const names = await companyNames(tx, [g.companyId]);
  return guestDto(g, stats, g.companyId ? (names.get(g.companyId) ?? null) : null);
}

export async function listGuests(
  tx: DbOrTx,
  ctx: PropertyContext,
  q: { q?: string | undefined; filter?: 'vip' | 'blacklisted' | 'regular' | 'corporate' | undefined; cursor?: string | undefined; limit: number },
) {
  const conds: SQL[] = [eq(guests.orgId, ctx.orgId), isNull(guests.mergedInto)];
  const term = q.q?.trim();
  if (term) {
    const digits = term.replace(/\D+/g, '');
    const parts: SQL[] = [sql`${nameExpr} like ${'%' + term.toLowerCase() + '%'}`];
    if (digits.length >= 3) parts.push(sql`${guests.phoneNorm} like ${'%' + digits + '%'}`);
    const doc = normalizeDocNumber(term);
    if (doc) parts.push(sql`${guests.docNumberNorm} like ${doc + '%'}`);
    conds.push(or(...parts)!);
  }
  if (q.filter === 'vip') conds.push(eq(guests.isVip, true));
  if (q.filter === 'blacklisted') conds.push(eq(guests.blacklisted, true));
  if (q.filter === 'corporate') conds.push(sql`${guests.companyId} is not null`);
  if (q.filter === 'regular') {
    conds.push(sql`(select count(*) from bookings b where b.guest_id = ${guests.id} and b.status in ('checked_in','checked_out')) >= 2`);
  }
  const cursor = decodeCursor<[string, string, string]>(q.cursor);
  if (cursor) {
    conds.push(sql`(${guests.lastName}, ${guests.firstName}, ${guests.id}) > (${cursor[0]}, ${cursor[1]}, ${cursor[2]})`);
  }
  const rows = await tx
    .select()
    .from(guests)
    .where(and(...conds))
    .orderBy(asc(guests.lastName), asc(guests.firstName), asc(guests.id))
    .limit(q.limit + 1);
  const page = pageOf(rows, q.limit, (r) => [r.lastName, r.firstName, r.id]);
  const stats = await guestStats(tx, page.items.map((r) => r.id));
  const names = await companyNames(tx, page.items.map((r) => r.companyId));
  return {
    items: page.items.map((g) => listItemDto(g, stats.get(g.id) ?? EMPTY_STATS, g.companyId ? (names.get(g.companyId) ?? null) : null)),
    nextCursor: page.nextCursor,
  };
}

function columnsFromInput(input: Partial<GuestInputT>) {
  const out: Partial<typeof guests.$inferInsert> = {};
  if (input.lastName !== undefined) out.lastName = input.lastName.trim();
  if (input.firstName !== undefined) out.firstName = input.firstName.trim();
  if (input.middleName !== undefined) out.middleName = trimOrNull(input.middleName);
  if (input.birthDate !== undefined) out.birthDate = input.birthDate;
  if (input.gender !== undefined) out.gender = input.gender;
  if (input.citizenship !== undefined) out.citizenship = input.citizenship;
  if (input.docType !== undefined) out.docType = input.docType;
  if (input.docNumber !== undefined) {
    out.docNumber = trimOrNull(input.docNumber);
    out.docNumberNorm = normalizeDocNumber(input.docNumber);
  }
  if (input.docIssuedBy !== undefined) out.docIssuedBy = trimOrNull(input.docIssuedBy);
  if (input.docIssuedOn !== undefined) out.docIssuedOn = input.docIssuedOn;
  if (input.docExpiresOn !== undefined) out.docExpiresOn = input.docExpiresOn;
  if (input.personalNumber !== undefined) out.personalNumber = trimOrNull(input.personalNumber);
  if (input.address !== undefined) out.address = trimOrNull(input.address);
  if (input.phone !== undefined) {
    out.phone = trimOrNull(input.phone);
    out.phoneNorm = normalizePhone(input.phone);
  }
  if (input.email !== undefined) out.email = normalizeEmail(input.email);
  if (input.language !== undefined) out.language = trimOrNull(input.language);
  if (input.companyId !== undefined) out.companyId = input.companyId;
  if (input.isVip !== undefined) out.isVip = input.isVip;
  if (input.preferences !== undefined) out.preferences = input.preferences;
  if (input.notes !== undefined) out.notes = trimOrNull(input.notes);
  if (input.marketingConsent !== undefined) out.marketingConsent = input.marketingConsent;
  return out;
}

async function assertCompany(tx: DbOrTx, ctx: PropertyContext, companyId: string | null | undefined) {
  if (!companyId) return;
  const [c] = await tx.select({ id: companies.id }).from(companies).where(and(eq(companies.id, companyId), eq(companies.orgId, ctx.orgId)));
  if (!c) throw notFound('company.not_found', 'Компания не найдена');
}

/** Гость с тем же документом: «одна запись гостя». */
async function findByDocument(tx: DbOrTx, ctx: PropertyContext, docNumberNorm: string | null, citizenship: string | null, exceptId?: string) {
  if (!docNumberNorm) return null;
  const conds: SQL[] = [
    eq(guests.orgId, ctx.orgId),
    isNull(guests.mergedInto),
    eq(guests.docNumberNorm, docNumberNorm),
    sql`coalesce(${guests.citizenship}, '') = ${citizenship ?? ''}`,
  ];
  if (exceptId) conds.push(sql`${guests.id} <> ${exceptId}`);
  const [row] = await tx.select().from(guests).where(and(...conds)).limit(1);
  return row ?? null;
}

export async function createGuest(tx: DbOrTx, ctx: PropertyContext, input: GuestInputT): Promise<GuestRow> {
  await assertCompany(tx, ctx, input.companyId);
  const cols = columnsFromInput(input);
  const dup = await findByDocument(tx, ctx, cols.docNumberNorm ?? null, cols.citizenship ?? null);
  if (dup) {
    throw conflict('guest.duplicate', 'Гость с таким документом уже есть в базе', fullName(dup), { guestId: dup.id });
  }
  const [row] = await tx
    .insert(guests)
    .values({
      id: newId(),
      orgId: ctx.orgId,
      lastName: input.lastName.trim(),
      firstName: input.firstName.trim(),
      ...cols,
      marketingConsentAt: input.marketingConsent ? new Date() : null,
      createdBy: ctx.actor.id,
    })
    .returning();
  await audit(tx, ctx, {
    action: 'guest.create',
    entityType: 'guest',
    entityId: row!.id,
    entityLabel: fullName(row!),
    after: cols as Record<string, unknown>,
  });
  await emit(tx, ctx, 'guest.changed', row!.id);
  return row!;
}

export async function updateGuest(
  tx: DbOrTx,
  ctx: PropertyContext,
  id: string,
  input: Partial<GuestInputT> & { blacklisted?: boolean | undefined; blacklistReason?: string | null | undefined },
  version: number | null,
): Promise<GuestRow> {
  const before = await loadGuest(tx, ctx, id, { forUpdate: true });
  if (before.mergedInto) throw conflict('guest.merged', 'Карточка объединена с другой, изменения вносятся туда', undefined, { guestId: before.mergedInto });
  if (version != null && before.version !== version) {
    throw preconditionFailed('Карточку уже изменил другой сотрудник', 'Обновите карточку и внесите правку заново.', { currentVersion: before.version });
  }
  await assertCompany(tx, ctx, input.companyId);
  const cols = columnsFromInput(input);
  if (input.blacklisted !== undefined && input.blacklisted !== before.blacklisted) {
    requirePermission(ctx, 'guest.blacklist', 'Чёрный список ведут старший администратор и управляющий');
    if (input.blacklisted && !trimOrNull(input.blacklistReason)) {
      throw badRequest('guest.blacklist_reason', 'Укажите причину внесения в чёрный список');
    }
    cols.blacklisted = input.blacklisted;
    cols.blacklistReason = input.blacklisted ? trimOrNull(input.blacklistReason) : null;
  }
  if (cols.docNumberNorm !== undefined) {
    const dup = await findByDocument(tx, ctx, cols.docNumberNorm ?? null, cols.citizenship ?? before.citizenship, before.id);
    if (dup) throw conflict('guest.duplicate', 'Гость с таким документом уже есть в базе', fullName(dup), { guestId: dup.id });
  }
  if (input.marketingConsent !== undefined && input.marketingConsent !== before.marketingConsent) {
    cols.marketingConsentAt = input.marketingConsent ? new Date() : null;
  }
  const [after] = await tx
    .update(guests)
    .set({ ...cols, updatedAt: new Date(), version: before.version + 1 })
    .where(eq(guests.id, before.id))
    .returning();
  await audit(tx, ctx, {
    action: 'guest.update',
    entityType: 'guest',
    entityId: before.id,
    entityLabel: fullName(after!),
    before: before as unknown as Record<string, unknown>,
    after: after as unknown as Record<string, unknown>,
    reason: input.blacklisted ? (input.blacklistReason ?? null) : null,
  });
  await emit(tx, ctx, 'guest.changed', before.id);
  return after!;
}

/**
 * Найти или создать гостя для брони и заселения. Совпадение по документу -
 * это тот же человек: карточка обновляется, дубль не создаётся. Совпадение
 * только по телефону принимается, если совпадает и фамилия (телефон бывает
 * общим на семью).
 */
export async function resolveGuest(
  tx: DbOrTx,
  ctx: PropertyContext,
  ref: { guestId?: string | null | undefined; guest?: GuestInputT | null | undefined },
): Promise<GuestRow> {
  if (ref.guestId) {
    const existing = await loadGuest(tx, ctx, ref.guestId);
    if (existing.mergedInto) return loadGuest(tx, ctx, existing.mergedInto);
    if (ref.guest) return updateGuest(tx, ctx, existing.id, ref.guest, null);
    return existing;
  }
  if (!ref.guest) throw badRequest('booking.guest_required', 'Укажите гостя');
  const input = ref.guest;
  const docNorm = normalizeDocNumber(input.docNumber);
  const byDoc = await findByDocument(tx, ctx, docNorm, input.citizenship ?? null);
  if (byDoc) return updateGuest(tx, ctx, byDoc.id, input, null);
  const phoneNorm = normalizePhone(input.phone);
  if (phoneNorm) {
    const [byPhone] = await tx
      .select()
      .from(guests)
      .where(
        and(
          eq(guests.orgId, ctx.orgId),
          isNull(guests.mergedInto),
          eq(guests.phoneNorm, phoneNorm),
          sql`lower(${guests.lastName}) = lower(${input.lastName.trim()})`,
        ),
      )
      .limit(1);
    if (byPhone && (!byPhone.docNumberNorm || !docNorm || byPhone.docNumberNorm === docNorm)) {
      return updateGuest(tx, ctx, byPhone.id, input, null);
    }
  }
  return createGuest(tx, ctx, input);
}

export async function matchGuests(
  tx: DbOrTx,
  ctx: PropertyContext,
  c: { docNumber?: string | null | undefined; citizenship?: string | null | undefined; phone?: string | null | undefined; lastName?: string | null | undefined; firstName?: string | null | undefined; birthDate?: string | null | undefined; excludeId?: string | undefined },
) {
  const docNorm = normalizeDocNumber(c.docNumber);
  const phoneNorm = normalizePhone(c.phone);
  const parts: SQL[] = [];
  if (docNorm) parts.push(eq(guests.docNumberNorm, docNorm));
  if (phoneNorm) parts.push(eq(guests.phoneNorm, phoneNorm));
  if (c.lastName && c.birthDate) {
    parts.push(and(sql`lower(${guests.lastName}) = lower(${c.lastName.trim()})`, eq(guests.birthDate, c.birthDate))!);
  }
  if (!parts.length) return [];
  const conds: SQL[] = [eq(guests.orgId, ctx.orgId), isNull(guests.mergedInto), or(...parts)!];
  if (c.excludeId) conds.push(sql`${guests.id} <> ${c.excludeId}`);
  const rows = await tx.select().from(guests).where(and(...conds)).limit(10);
  const stats = await guestStats(tx, rows.map((r) => r.id));
  const names = await companyNames(tx, rows.map((r) => r.companyId));
  return rows
    .map((g) => {
      const reasons: ('document' | 'phone' | 'name_birth')[] = [];
      if (docNorm && g.docNumberNorm === docNorm) reasons.push('document');
      if (phoneNorm && g.phoneNorm === phoneNorm) reasons.push('phone');
      if (c.lastName && c.birthDate && g.birthDate === c.birthDate && g.lastName.toLowerCase() === c.lastName.trim().toLowerCase()) {
        reasons.push('name_birth');
      }
      const strength: 'strong' | 'possible' = reasons.includes('document') || reasons.length >= 2 ? 'strong' : 'possible';
      return {
        guest: listItemDto(g, stats.get(g.id) ?? EMPTY_STATS, g.companyId ? (names.get(g.companyId) ?? null) : null),
        reasons,
        strength,
      };
    })
    .sort((a, b) => (a.strength === b.strength ? b.reasons.length - a.reasons.length : a.strength === 'strong' ? -1 : 1));
}

/**
 * Объединение дублей. История, брони и сканы переезжают в основную карточку;
 * пустые поля основной заполняются из дубля. Дубль не удаляется: остаётся со
 * ссылкой mergedInto, чтобы старые ссылки и журнал вели куда надо.
 */
export async function mergeGuests(tx: DbOrTx, ctx: PropertyContext, primaryId: string, duplicateId: string) {
  if (primaryId === duplicateId) throw badRequest('guest.merge_self', 'Нельзя объединить карточку саму с собой');
  const primary = await loadGuest(tx, ctx, primaryId, { forUpdate: true });
  const dup = await loadGuest(tx, ctx, duplicateId, { forUpdate: true });
  if (primary.mergedInto || dup.mergedInto) throw conflict('guest.merged', 'Одна из карточек уже объединена');

  const fill: Partial<typeof guests.$inferInsert> = {};
  const keys = [
    'middleName', 'birthDate', 'gender', 'citizenship', 'docType', 'docIssuedBy', 'docIssuedOn',
    'docExpiresOn', 'personalNumber', 'address', 'phone', 'phoneNorm', 'email', 'language', 'companyId',
    'pdConsentAt', 'pdConsentMethod',
  ] as const;
  for (const k of keys) {
    if (primary[k] == null && dup[k] != null) (fill as Record<string, unknown>)[k] = dup[k];
  }
  if (!primary.docNumberNorm && dup.docNumberNorm) {
    // Освобождаем документ у дубля до переноса: уникальный индекс не пропустит две карточки.
    await tx.update(guests).set({ mergedInto: primary.id, mergedAt: new Date(), updatedAt: new Date() }).where(eq(guests.id, dup.id));
    fill.docNumber = dup.docNumber;
    fill.docNumberNorm = dup.docNumberNorm;
  }
  if (dup.isVip) fill.isVip = true;
  if (dup.blacklisted && !primary.blacklisted) {
    fill.blacklisted = true;
    fill.blacklistReason = dup.blacklistReason;
  }
  const notes = [primary.notes, dup.notes].filter(Boolean).join('\n');
  if (notes && notes !== primary.notes) fill.notes = notes;

  await tx.update(bookings).set({ guestId: primary.id }).where(eq(bookings.guestId, dup.id));
  await tx.update(guestDocuments).set({ guestId: primary.id }).where(eq(guestDocuments.guestId, dup.id));
  await tx.update(guests).set({ mergedInto: primary.id, mergedAt: new Date(), updatedAt: new Date() }).where(eq(guests.id, dup.id));
  const [after] = await tx
    .update(guests)
    .set({ ...fill, updatedAt: new Date(), version: primary.version + 1 })
    .where(eq(guests.id, primary.id))
    .returning();
  await audit(tx, ctx, {
    action: 'guest.merge',
    entityType: 'guest',
    entityId: primary.id,
    entityLabel: fullName(primary),
    changes: { mergedFrom: [null, `${fullName(dup)} (${dup.id})`], ...Object.fromEntries(Object.entries(fill).map(([k, v]) => [k, [null, v]])) },
  });
  await audit(tx, ctx, {
    action: 'guest.merged_into',
    entityType: 'guest',
    entityId: dup.id,
    entityLabel: fullName(dup),
    changes: { mergedInto: [null, primary.id] },
  });
  await emit(tx, ctx, 'guest.changed', primary.id);
  return after!;
}

export async function recordConsent(tx: DbOrTx, ctx: PropertyContext, guestId: string, method: 'paper' | 'tablet') {
  const g = await loadGuest(tx, ctx, guestId, { forUpdate: true });
  const at = new Date();
  await tx
    .update(guests)
    .set({ pdConsentAt: at, pdConsentMethod: method, updatedAt: at, version: g.version + 1 })
    .where(eq(guests.id, g.id));
  await audit(tx, ctx, {
    action: 'guest.pd_consent',
    entityType: 'guest',
    entityId: g.id,
    entityLabel: fullName(g),
    changes: { pdConsentAt: [iso(g.pdConsentAt), at.toISOString()], pdConsentMethod: [g.pdConsentMethod, method] },
  });
}

export async function guestStays(tx: DbOrTx, ctx: PropertyContext, guestId: string) {
  await loadGuest(tx, ctx, guestId);
  const rows = await tx
    .select({
      b: bookings,
      propertyName: properties.name,
      roomNumber: rooms.number,
      roomTypeName: roomTypes.name,
      items: sql<string>`coalesce((select sum(amount) from folio_items fi where fi.booking_id = ${bookings.id}), 0)`,
    })
    .from(bookings)
    .innerJoin(properties, eq(properties.id, bookings.propertyId))
    .innerJoin(rooms, eq(rooms.id, bookings.roomId))
    .innerJoin(roomTypes, eq(roomTypes.id, bookings.roomTypeId))
    .where(and(eq(bookings.guestId, guestId), eq(properties.orgId, ctx.orgId)))
    .orderBy(desc(bookings.arrival));
  const showMoney = can(ctx, 'folio.view');
  return rows.map((r) => ({
    bookingId: r.b.id,
    number: r.b.number,
    propertyName: r.propertyName,
    status: r.b.status,
    arrival: r.b.arrival,
    departure: r.b.departure,
    roomNumber: r.roomNumber,
    roomTypeName: r.roomTypeName,
    total: showMoney ? r.b.accommodationTotal + r.b.mealTotal + Number(r.items) : 0,
    rating: r.b.rating,
    feedback: r.b.feedback,
    cancelReason: r.b.cancelReason,
  }));
}
