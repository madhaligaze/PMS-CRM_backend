import { aliasedTable, and, asc, eq, gt, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { audit, emit } from '../../core/audit.ts';
import { can, requirePermission, type PropertyContext } from '../../core/context.ts';
import { iso } from '../../core/http.ts';
import type { DbOrTx } from '../../db/client.ts';
import { bookings, guests, hkTasks, memberships, positions, roomBlocks, rooms, roomTypes, users, type ChecklistItem } from '../../db/schema/index.ts';
import { cleanRights, levelOf } from '../../lib/access.ts';
import { zonedToUtc } from '../../lib/dates.ts';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { fullName, trimOrNull } from '../../lib/normalize.ts';
import { today } from '../bookings/service.ts';

type TaskRow = typeof hkTasks.$inferSelect;
type RoomRow = typeof rooms.$inferSelect;
type HkStatus = RoomRow['hkStatus'];

export const HK_LABEL: Record<HkStatus, string> = {
  dirty: 'Грязный',
  cleaning: 'В уборке',
  clean: 'Убран',
  inspected: 'Проверен',
  repair: 'На ремонте',
};

export const KIND_LABEL: Record<TaskRow['kind'], string> = {
  departure: 'Уборка после выезда',
  stayover: 'Ежедневная уборка',
  request: 'По запросу гостя',
  general: 'Генеральная уборка',
};

export const GENERAL_CHECKLIST = [
  'Мытьё окон и подоконников',
  'Чистка штор и мягкой мебели',
  'Пыль за мебелью и на высоких поверхностях',
  'Дезинфекция санузла, затирки, сливов',
  'Проверка матрасов и подушек',
  'Чистка фильтров кондиционера',
];

const assignee = aliasedTable(users, 'assignee');
const inspector = aliasedTable(users, 'inspector');

export async function taskDtos(tx: DbOrTx, conds: SQL[]) {
  const rows = await tx
    .select({ t: hkTasks, roomNumber: rooms.number, assigneeName: assignee.fullName, inspectorName: inspector.fullName })
    .from(hkTasks)
    .innerJoin(rooms, eq(rooms.id, hkTasks.roomId))
    .leftJoin(assignee, eq(assignee.id, hkTasks.assigneeId))
    .leftJoin(inspector, eq(inspector.id, hkTasks.inspectedBy))
    .where(and(...conds))
    .orderBy(asc(hkTasks.businessDate), asc(rooms.sort), asc(rooms.number), asc(hkTasks.createdAt));
  const now = Date.now();
  return rows.map((r) => ({
    id: r.t.id,
    roomId: r.t.roomId,
    roomNumber: r.roomNumber,
    kind: r.t.kind,
    status: r.t.status,
    businessDate: r.t.businessDate,
    assigneeId: r.t.assigneeId,
    assigneeName: r.assigneeName,
    dueAt: iso(r.t.dueAt),
    overdue: !!r.t.dueAt && r.t.dueAt.getTime() < now && (r.t.status === 'open' || r.t.status === 'in_progress'),
    note: r.t.note,
    checklist: r.t.checklist,
    photoFileIds: r.t.photoFileIds,
    startedAt: iso(r.t.startedAt),
    finishedAt: iso(r.t.finishedAt),
    inspectedAt: iso(r.t.inspectedAt),
    inspectedBy: r.inspectorName,
    skipReason: r.t.skipReason,
    createdAt: r.t.createdAt.toISOString(),
    updatedAt: r.t.updatedAt.toISOString(),
    version: r.t.version,
  }));
}

export async function taskDto(tx: DbOrTx, id: string) {
  const [t] = await taskDtos(tx, [eq(hkTasks.id, id)]);
  if (!t) throw notFound('task.not_found', 'Задача не найдена');
  return t;
}

/** Горничная видит только свои задачи; супервайзер и управляющий - все. */
function ownOnly(ctx: PropertyContext): boolean {
  return !can(ctx, 'hk.view') && !can(ctx, 'hk.assign');
}

export async function listTasks(
  tx: DbOrTx,
  ctx: PropertyContext,
  q: { date?: string | undefined; assignee?: string | undefined; status?: TaskRow['status'][] | undefined; updatedSince?: string | undefined },
) {
  const conds: SQL[] = [eq(hkTasks.propertyId, ctx.propertyId)];
  if (q.updatedSince) {
    conds.push(gt(hkTasks.updatedAt, new Date(q.updatedSince)));
  } else {
    conds.push(eq(hkTasks.businessDate, q.date ?? today(ctx)));
  }
  if (ownOnly(ctx)) {
    // Свои задачи плюс никому не назначенные: их горничная может взять сама.
    conds.push(or(eq(hkTasks.assigneeId, ctx.actor.id!), sql`${hkTasks.assigneeId} is null`)!);
  } else if (q.assignee === 'me') {
    conds.push(eq(hkTasks.assigneeId, ctx.actor.id!));
  } else if (q.assignee) {
    conds.push(eq(hkTasks.assigneeId, q.assignee));
  }
  if (q.status?.length) conds.push(inArray(hkTasks.status, q.status));
  return taskDtos(tx, conds);
}

export async function board(tx: DbOrTx, ctx: PropertyContext) {
  const day = today(ctx);
  const roomRows = await tx
    .select({ r: rooms, typeName: roomTypes.name })
    .from(rooms)
    .innerJoin(roomTypes, eq(roomTypes.id, rooms.roomTypeId))
    .where(and(eq(rooms.propertyId, ctx.propertyId), eq(rooms.isActive, true)))
    .orderBy(asc(rooms.sort), asc(rooms.number));
  const stays = await tx
    .select({ b: bookings, g: guests })
    .from(bookings)
    .innerJoin(guests, eq(guests.id, bookings.guestId))
    .where(
      and(
        eq(bookings.propertyId, ctx.propertyId),
        inArray(bookings.status, ['tentative', 'confirmed', 'checked_in', 'checked_out']),
        lte(bookings.arrival, day),
        gte(bookings.departure, day),
      ),
    );
  const blocks = await tx
    .select()
    .from(roomBlocks)
    .where(and(eq(roomBlocks.propertyId, ctx.propertyId), eq(roomBlocks.isActive, true), lte(roomBlocks.startsOn, day), gt(roomBlocks.endsOn, day)));
  const tasks = await taskDtos(tx, [eq(hkTasks.propertyId, ctx.propertyId), eq(hkTasks.businessDate, day)]);
  const showGuests = can(ctx, 'guest.view');

  // Кому можно поручить уборку: у кого открыта «Уборка номеров» или хозслужба целиком.
  const staff = can(ctx, 'hk.assign')
    ? (
        await tx
          .select({ id: users.id, name: users.fullName, access: memberships.access, rights: memberships.rights, position: positions.name })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .leftJoin(positions, eq(positions.id, memberships.positionId))
          .where(and(eq(memberships.propertyId, ctx.propertyId), eq(memberships.access, 'staff'), eq(users.isActive, true), isNull(users.archivedAt)))
          .orderBy(asc(users.fullName))
      ).filter((s) => {
        const rights = cleanRights(s.rights);
        return levelOf(rights, 'cleaning') === 'edit' || levelOf(rights, 'housekeeping') === 'edit';
      })
    : [];

  return {
    businessDate: day,
    rooms: roomRows.map(({ r, typeName }) => {
      const roomStays = stays.filter((s) => s.b.roomId === r.id);
      const inHouse = roomStays.find((s) => s.b.status === 'checked_in' && s.b.departure > day);
      const departing = roomStays.find((s) => s.b.departure === day && (s.b.status === 'checked_in' || s.b.status === 'checked_out'));
      const arriving = roomStays.find((s) => s.b.arrival === day && (s.b.status === 'tentative' || s.b.status === 'confirmed' || s.b.status === 'checked_in'));
      const blocked = blocks.some((k) => k.roomId === r.id);
      let occupancy: 'free' | 'occupied' | 'arrival' | 'departure' | 'turnover' | 'blocked' = 'free';
      if (blocked) occupancy = 'blocked';
      else if (departing && arriving) occupancy = 'turnover';
      else if (departing) occupancy = 'departure';
      else if (arriving && arriving.b.status !== 'checked_in') occupancy = 'arrival';
      else if (inHouse || arriving) occupancy = 'occupied';
      const name = (s: (typeof stays)[number] | undefined) => (s && showGuests ? fullName(s.g) : null);
      return {
        id: r.id,
        number: r.number,
        roomTypeName: typeName,
        floor: r.floor,
        hkStatus: r.hkStatus,
        hkStatusAt: r.hkStatusAt.toISOString(),
        dnd: r.dnd,
        occupancy,
        arrivalGuest: name(arriving && arriving.b.status !== 'checked_in' ? arriving : undefined),
        departureGuest: name(departing),
        inHouseGuest: name(inHouse),
        departureDone: departing?.b.status === 'checked_out',
        tasks: tasks.filter((t) => t.roomId === r.id),
      };
    }),
    staff: staff.map((s) => ({ id: s.id, name: s.name, position: s.position })),
  };
}

async function loadTask(tx: DbOrTx, ctx: PropertyContext, id: string) {
  const [t] = await tx
    .select()
    .from(hkTasks)
    .where(and(eq(hkTasks.id, id), eq(hkTasks.propertyId, ctx.propertyId)))
    .for('update');
  if (!t) throw notFound('task.not_found', 'Задача не найдена');
  return t;
}

function assertActor(ctx: PropertyContext, t: TaskRow) {
  if (can(ctx, 'hk.assign')) return;
  requirePermission(ctx, 'hk.own_tasks');
  if (t.assigneeId && t.assigneeId !== ctx.actor.id) throw forbidden('task.not_yours', 'Это задача другой горничной');
}

/**
 * Состояние номера. Из ремонта номер выходит только закрытием заявки
 * (fromRepair), иначе уборка поверх ремонта вернула бы его в продажу.
 */
export async function setRoomStatus(
  tx: DbOrTx,
  ctx: PropertyContext,
  roomId: string,
  status: HkStatus,
  reason: string | null,
  opts: { fromRepair?: boolean } = {},
) {
  const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).for('update');
  if (!room || room.hkStatus === status) return;
  if (room.hkStatus === 'repair' && !opts.fromRepair) return;
  await tx
    .update(rooms)
    .set({ hkStatus: status, hkStatusAt: new Date(), hkStatusBy: ctx.actor.id, ...(status === 'cleaning' ? { dnd: false } : {}), version: room.version + 1 })
    .where(eq(rooms.id, room.id));
  await audit(tx, ctx, {
    action: 'room.hk_status',
    entityType: 'room',
    entityId: room.id,
    entityLabel: `Номер ${room.number}`,
    changes: { hkStatus: [HK_LABEL[room.hkStatus], HK_LABEL[status]] },
    reason,
  });
  await emit(tx, ctx, 'room.changed', room.id);
}

async function touch(tx: DbOrTx, ctx: PropertyContext, t: TaskRow, patch: Partial<typeof hkTasks.$inferInsert>, action: string, reason?: string | null) {
  await tx
    .update(hkTasks)
    .set({ ...patch, updatedAt: new Date(), version: t.version + 1 })
    .where(eq(hkTasks.id, t.id));
  const [room] = await tx.select({ number: rooms.number }).from(rooms).where(eq(rooms.id, t.roomId));
  await audit(tx, ctx, {
    action,
    entityType: 'hk_task',
    entityId: t.id,
    entityLabel: `${KIND_LABEL[t.kind]}, номер ${room?.number ?? ''}`,
    changes: Object.fromEntries(
      Object.entries(patch)
        .filter(([k]) => ['status', 'assigneeId', 'skipReason', 'note'].includes(k))
        .map(([k, v]) => [k, [(t as Record<string, unknown>)[k] ?? null, v ?? null]]),
    ),
    reason: reason ?? null,
  });
  await emit(tx, ctx, 'hk.task.changed', t.id, { roomId: t.roomId });
}

export async function createTask(
  tx: DbOrTx,
  ctx: PropertyContext,
  input: { roomId: string; kind: 'request' | 'general' | 'stayover' | 'departure'; note?: string | null | undefined; assigneeId?: string | null | undefined; dueAt?: string | null | undefined },
) {
  const [room] = await tx.select().from(rooms).where(and(eq(rooms.id, input.roomId), eq(rooms.propertyId, ctx.propertyId)));
  if (!room) throw notFound('room.not_found', 'Номер не найден');
  if (input.assigneeId) requirePermission(ctx, 'hk.assign');
  const day = today(ctx);
  const id = newId();
  await tx.insert(hkTasks).values({
    id,
    propertyId: ctx.propertyId,
    roomId: room.id,
    kind: input.kind,
    businessDate: day,
    assigneeId: input.assigneeId ?? null,
    dueAt: input.dueAt ? new Date(input.dueAt) : zonedToUtc(day, ctx.property.settings.dailyCleaningDue, ctx.property.timezone),
    note: trimOrNull(input.note),
    checklist: input.kind === 'general' ? GENERAL_CHECKLIST.map((text) => ({ text, done: false })) : [],
    createdBy: ctx.actor.id,
  });
  await audit(tx, ctx, {
    action: 'hk_task.create',
    entityType: 'hk_task',
    entityId: id,
    entityLabel: `${KIND_LABEL[input.kind]}, номер ${room.number}`,
    changes: { note: [null, trimOrNull(input.note)] },
  });
  await emit(tx, ctx, 'hk.task.changed', id, { roomId: room.id });
  return id;
}

export async function assignTask(tx: DbOrTx, ctx: PropertyContext, id: string, input: { assigneeId?: string | null | undefined; dueAt?: string | null | undefined; note?: string | null | undefined }) {
  requirePermission(ctx, 'hk.assign');
  const t = await loadTask(tx, ctx, id);
  if (t.status !== 'open' && t.status !== 'in_progress') throw conflict('task.closed', 'Задача уже закрыта');
  if (input.assigneeId) {
    const [m] = await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.userId, input.assigneeId), eq(memberships.propertyId, ctx.propertyId), isNull(users.archivedAt)));
    if (!m) throw notFound('user.not_found', 'Сотрудник не найден');
  }
  await touch(
    tx,
    ctx,
    t,
    {
      ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt ? new Date(input.dueAt) : null } : {}),
      ...(input.note !== undefined ? { note: trimOrNull(input.note) } : {}),
    },
    'hk_task.assign',
  );
}

export async function startTask(tx: DbOrTx, ctx: PropertyContext, id: string) {
  const t = await loadTask(tx, ctx, id);
  assertActor(ctx, t);
  if (t.status !== 'open') throw conflict('task.status', 'Начать можно только открытую задачу');
  const [room] = await tx.select().from(rooms).where(eq(rooms.id, t.roomId));
  if (room?.dnd) throw conflict('room.dnd', `На номере ${room.number} «Не беспокоить»`);
  await touch(tx, ctx, t, { status: 'in_progress', startedAt: new Date(), assigneeId: t.assigneeId ?? ctx.actor.id }, 'hk_task.start');
  await setRoomStatus(tx, ctx, t.roomId, 'cleaning', null);
}

export async function finishTask(tx: DbOrTx, ctx: PropertyContext, id: string, input: { checklist?: ChecklistItem[] | undefined; photoFileIds?: string[] | undefined; note?: string | null | undefined }) {
  const t = await loadTask(tx, ctx, id);
  assertActor(ctx, t);
  if (t.status !== 'in_progress') throw conflict('task.status', 'Закончить можно задачу в работе');
  const checklist = input.checklist ?? t.checklist;
  if (t.kind === 'general' && checklist.some((c) => !c.done)) {
    throw badRequest('task.checklist', 'Генеральная уборка: отметьте все пункты чек-листа или пропустите задачу с причиной');
  }
  await touch(
    tx,
    ctx,
    t,
    {
      status: 'done',
      finishedAt: new Date(),
      checklist,
      ...(input.photoFileIds ? { photoFileIds: input.photoFileIds } : {}),
      ...(input.note !== undefined ? { note: trimOrNull(input.note) } : {}),
    },
    'hk_task.finish',
  );
  await setRoomStatus(tx, ctx, t.roomId, 'clean', null);
}

/** Супервайзер принимает номер («проверен») или возвращает на доуборку. */
export async function inspectTask(tx: DbOrTx, ctx: PropertyContext, id: string, input: { ok: boolean; note?: string | null | undefined }) {
  requirePermission(ctx, 'hk.inspect');
  const t = await loadTask(tx, ctx, id);
  if (t.status !== 'done') throw conflict('task.status', 'Принять можно только законченную уборку');
  if (input.ok) {
    await touch(tx, ctx, t, { status: 'inspected', inspectedAt: new Date(), inspectedBy: ctx.actor.id }, 'hk_task.inspect');
    await setRoomStatus(tx, ctx, t.roomId, 'inspected', null);
  } else {
    const note = trimOrNull(input.note);
    if (!note) throw badRequest('task.return_reason', 'Напишите, что переделать');
    await touch(tx, ctx, t, { status: 'open', finishedAt: null, startedAt: null, note }, 'hk_task.return', note);
    await setRoomStatus(tx, ctx, t.roomId, 'dirty', note);
  }
}

export async function skipTask(tx: DbOrTx, ctx: PropertyContext, id: string, input: { reason: 'dnd' | 'refused' | 'other'; note?: string | null | undefined }) {
  const t = await loadTask(tx, ctx, id);
  assertActor(ctx, t);
  if (t.status !== 'open' && t.status !== 'in_progress') throw conflict('task.status', 'Задача уже закрыта');
  const labels = { dnd: 'Не беспокоить', refused: 'Гость отказался от уборки', other: 'Другое' };
  const note = trimOrNull(input.note);
  if (input.reason === 'other' && !note) throw badRequest('task.skip_reason', 'Напишите причину');
  const reason = note ? `${labels[input.reason]}: ${note}` : labels[input.reason];
  await touch(tx, ctx, t, { status: 'skipped', skipReason: reason }, 'hk_task.skip', reason);
  if (input.reason === 'dnd') {
    const [room] = await tx.select().from(rooms).where(eq(rooms.id, t.roomId)).for('update');
    if (room && !room.dnd) {
      await tx.update(rooms).set({ dnd: true, version: room.version + 1 }).where(eq(rooms.id, room.id));
      await emit(tx, ctx, 'room.changed', room.id);
    }
  }
}

export async function setDnd(tx: DbOrTx, ctx: PropertyContext, roomId: string, on: boolean) {
  const [room] = await tx.select().from(rooms).where(and(eq(rooms.id, roomId), eq(rooms.propertyId, ctx.propertyId))).for('update');
  if (!room) throw notFound('room.not_found', 'Номер не найден');
  if (room.dnd === on) return;
  await tx.update(rooms).set({ dnd: on, version: room.version + 1 }).where(eq(rooms.id, room.id));
  await audit(tx, ctx, {
    action: 'room.dnd',
    entityType: 'room',
    entityId: room.id,
    entityLabel: `Номер ${room.number}`,
    changes: { dnd: [room.dnd, on] },
  });
  await emit(tx, ctx, 'room.changed', room.id);
}

/** Прямая смена состояния номера супервайзером (ремонт - только через заявку). */
export async function changeRoomStatus(tx: DbOrTx, ctx: PropertyContext, roomId: string, status: Exclude<HkStatus, 'repair'>, note: string | null) {
  requirePermission(ctx, 'hk.status');
  const [room] = await tx.select().from(rooms).where(and(eq(rooms.id, roomId), eq(rooms.propertyId, ctx.propertyId)));
  if (!room) throw notFound('room.not_found', 'Номер не найден');
  if (room.hkStatus === 'repair') throw conflict('room.repair', 'Номер на ремонте: состояние вернёт закрытие заявки');
  if (status === 'inspected') requirePermission(ctx, 'hk.inspect', 'Отметку «проверен» ставит супервайзер хозслужбы');
  await setRoomStatus(tx, ctx, roomId, status, note);
}
