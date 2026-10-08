import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, makeApp, plusDays, type Api } from '../helpers.ts';

/**
 * Гонки и нагрузка. Несколько администраторов жмут одно и то же в одну
 * секунду, планшеты и телефоны опрашивают сервер разом: учёт не должен ни
 * раздвоиться, ни упасть. Каждый тест берёт свои даты далеко впереди, чтобы
 * не задеть демо и соседние тесты.
 */
let app: FastifyInstance;
let owner: Api;
let reception: Api;
let reception2: Api;
let senior: Api;
let today: string;
let ratePlanId: string;
let rooms: { id: string; number: string; isActive: boolean }[];

beforeAll(async () => {
  app = await makeApp();
  owner = await as(app, 'owner');
  reception = await as(app, 'reception');
  reception2 = await as(app, 'reception2');
  senior = await as(app, 'senior');
  today = (await owner.get('')).body.businessDate;
  rooms = (await owner.get('/rooms')).body;
  ratePlanId = (await owner.get('/rate-plans')).body.find((p: { code: string }) => p.code === 'BAR').id;
});

afterAll(async () => {
  await app.close();
});

/** Номер, свободный на даты: по шахматке, с учётом блокировок. */
async function freeRoom(arrival: string, departure: string, skip: string[] = []): Promise<string> {
  const tape = (await owner.get(`/tape-chart?from=${arrival}&to=${departure}`)).body;
  const busy = new Set<string>([
    ...tape.bookings.filter((b: { arrival: string; departure: string; status: string }) => b.arrival < departure && b.departure > arrival && !['cancelled', 'no_show', 'checked_out'].includes(b.status)).map((b: { roomId: string }) => b.roomId),
    ...tape.blocks.map((b: { roomId: string }) => b.roomId),
    ...skip,
  ]);
  const room = rooms.find((r) => r.isActive && !busy.has(r.id));
  if (!room) throw new Error(`нет свободного номера на ${arrival} - ${departure}`);
  return room.id;
}

const bookingBody = (roomId: string, arrival: string, departure: string, lastName = 'Гонка') => ({
  guest: { lastName, firstName: 'Тест' },
  roomId,
  arrival,
  departure,
  ratePlanId,
  source: 'phone',
  status: 'confirmed',
});

async function ensureShift(api: Api) {
  const cash = (await api.get('/cash')).body;
  if (cash.shift) return cash.shift.id as string;
  if (!cash.clockedIn) expect((await api.post('/attendance/clock', { kind: 'in' })).status).toBeLessThan(300);
  const opened = await api.post('/cash/shifts', {});
  if (opened.status === 409) return (await api.get('/cash')).body.shift.id as string;
  expect(opened.status).toBe(201);
  return opened.body.id as string;
}

describe('гонки: одно действие разом с нескольких мест', () => {
  it('30 броней одного номера на одни даты разом: проходит ровно одна', async () => {
    const arrival = plusDays(today, 301);
    const departure = plusDays(today, 303);
    const roomId = await freeRoom(arrival, departure);
    const who = [reception, reception2, senior, owner];
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => who[i % who.length]!.post('/bookings', bookingBody(roomId, arrival, departure), { 'Idempotency-Key': `race-room-${i}-${Date.now()}` })),
    );
    const ok = results.filter((r) => r.status === 201);
    expect(ok).toHaveLength(1);
    const failed = results.filter((r) => r.status !== 201);
    expect(failed.every((r) => r.status === 409)).toBe(true);
    expect(failed.every((r) => r.body.code === 'room.occupied')).toBe(true);
    // На шахматке номер занят один раз.
    const tape = (await owner.get(`/tape-chart?from=${arrival}&to=${departure}`)).body;
    expect(tape.bookings.filter((b: { roomId: string; status: string }) => b.roomId === roomId && b.status !== 'cancelled')).toHaveLength(1);
  });

  it('пересекающиеся даты в одном номере разом: ни одной двойной ночи', async () => {
    const base = plusDays(today, 310);
    const roomId = await freeRoom(base, plusDays(base, 8));
    const spans = [
      [0, 3],
      [2, 5],
      [4, 7],
      [1, 2],
      [6, 8],
      [3, 4],
    ] as const;
    const results = await Promise.all(spans.map(([a, d], i) => reception.post('/bookings', bookingBody(roomId, plusDays(base, a), plusDays(base, d)), { 'Idempotency-Key': `race-span-${i}-${Date.now()}` })));
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    const nights = new Map<string, number>();
    for (const r of results.filter((x) => x.status === 201)) {
      for (const n of r.body.nights as { date: string }[]) nights.set(n.date, (nights.get(n.date) ?? 0) + 1);
    }
    expect([...nights.values()].every((c) => c === 1)).toBe(true);
    expect(results.some((r) => r.status === 201)).toBe(true);
  });

  it('один ключ идемпотентности 20 раз разом: одна бронь, остальные - повтор того же ответа', async () => {
    const arrival = plusDays(today, 320);
    const departure = plusDays(today, 321);
    const roomId = await freeRoom(arrival, departure);
    const key = `same-key-${Date.now()}`;
    const results = await Promise.all(Array.from({ length: 20 }, () => reception.post('/bookings', bookingBody(roomId, arrival, departure), { 'Idempotency-Key': key })));
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    const ids = new Set(results.filter((r) => r.status === 201).map((r) => r.body.id));
    expect(ids.size).toBe(1);
    const tape = (await owner.get(`/tape-chart?from=${arrival}&to=${departure}`)).body;
    expect(tape.bookings.filter((b: { roomId: string }) => b.roomId === roomId)).toHaveLength(1);
  });

  it('10 оплат одной брони разом: номера документов уникальны, баланс сходится до тиына', async () => {
    await ensureShift(reception);
    const arrival = plusDays(today, 330);
    const roomId = await freeRoom(arrival, plusDays(arrival, 2));
    const b = (await reception.post('/bookings', bookingBody(roomId, arrival, plusDays(arrival, 2)), { 'Idempotency-Key': `pay-race-${Date.now()}` })).body;
    const part = Math.floor(b.accommodationTotal / 10);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 ? reception2 : reception).post('/payments', { bookingId: b.id, method: i % 3 ? 'card' : 'cash', amount: part }, { 'Idempotency-Key': `pay-${b.id}-${i}` })),
    );
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    const numbers = results.map((r) => r.body.number as number);
    expect(new Set(numbers).size).toBe(10);
    const after = (await reception.get(`/bookings/${b.id}`)).body;
    expect(after.balance.due).toBe(b.accommodationTotal - part * 10);
    const folio = (await reception.get(`/bookings/${b.id}/folio`)).body;
    expect(folio.payments.filter((p: { kind: string }) => p.kind === 'payment')).toHaveLength(10);
  });

  it('одна оплата, нажатая дважды (один ключ): документ один', async () => {
    await ensureShift(reception);
    const arrival = plusDays(today, 335);
    const roomId = await freeRoom(arrival, plusDays(arrival, 1));
    const b = (await reception.post('/bookings', bookingBody(roomId, arrival, plusDays(arrival, 1)), { 'Idempotency-Key': `dbl-${Date.now()}` })).body;
    const key = `double-pay-${b.id}`;
    const [x, y] = await Promise.all([1, 2].map(() => reception.post('/payments', { bookingId: b.id, method: 'cash', amount: 100_000 }, { 'Idempotency-Key': key })));
    const created = [x!, y!].filter((r) => r.status === 201);
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(new Set(created.map((r) => r.body.id)).size).toBe(1);
    const folio = (await reception.get(`/bookings/${b.id}/folio`)).body;
    expect(folio.payments.filter((p: { kind: string }) => p.kind === 'payment')).toHaveLength(1);
  });

  it('две смены одной кассы разом не открываются', async () => {
    const hotel = await owner.post('/api/v1/properties', { name: `Гонка смен ${Date.now()}` });
    expect(hotel.status).toBe(201);
    const base = `/api/v1/properties/${hotel.body.id}`;
    expect((await owner.post(`${base}/attendance/clock`, { kind: 'in' })).status).toBeLessThan(300);
    const results = await Promise.all(Array.from({ length: 8 }, () => owner.post(`${base}/cash/shifts`, {})));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 201).every((r) => r.status === 409)).toBe(true);
    const shifts = (await owner.get(`${base}/cash/shifts`)).body.items;
    expect(shifts.filter((s: { status: string }) => s.status === 'open')).toHaveLength(1);
  });

  it('заселение одной брони с двух стоек разом: одно', async () => {
    const roomId = await freeRoom(today, plusDays(today, 1));
    const b = (await reception.post('/bookings', bookingBody(roomId, today, plusDays(today, 1), 'Двойное'), { 'Idempotency-Key': `ci-race-${Date.now()}` })).body;
    const g = (await reception.get(`/guests/${b.guest.id}`)).body;
    expect(
      (
        await reception.patch(
          `/guests/${b.guest.id}`,
          { docType: 'id_card', docNumber: '099900025', citizenship: 'KAZ', birthDate: '1990-01-01', personalNumber: '900101300811' },
          { 'If-Match': `"${g.version}"` },
        )
      ).status,
    ).toBe(200);
    await reception.post(`/guests/${b.guest.id}/consent`, { method: 'paper' });
    const supervisor = await as(app, 'supervisor');
    await supervisor.post(`/rooms/${roomId}/hk-status`, { status: 'inspected' });
    const results = await Promise.all([reception, reception2, senior].map((api) => api.post(`/bookings/${b.id}/check-in`, { keyIssued: true })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 200).every((r) => r.status === 409)).toBe(true);
  });

  it('две горничные хватают одну свободную уборку: достаётся одной', async () => {
    const supervisor = await as(app, 'supervisor');
    const maid = await as(app, 'maid');
    const maid2 = await as(app, 'maid2');
    const board = (await supervisor.get('/housekeeping/board')).body;
    const room = board.rooms.find((r: { occupancy: string; dnd: boolean; hkStatus: string }) => r.occupancy !== 'blocked' && !r.dnd && r.hkStatus !== 'repair');
    expect(room, 'нужен номер без «не беспокоить» и не на ремонте').toBeTruthy();
    const task = await supervisor.post('/housekeeping/tasks', { roomId: room.id, kind: 'request', note: 'гонка горничных' }, { 'Idempotency-Key': `hk-race-${Date.now()}` });
    expect(task.status).toBe(201);
    const results = await Promise.all([maid, maid2].map((api) => api.post(`/housekeeping/tasks/${task.body.id}/start`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 200).every((r) => r.status === 409 || r.status === 403)).toBe(true);
  });

  it('двух сотрудников с одним логином разом не нанять', async () => {
    const login = `race.${Date.now()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => owner.post('/staff', { login, fullName: `Гонка Найма ${i}`, positionName: 'Горничная', access: 'staff' })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 201).every((r) => r.status === 409)).toBe(true);
  });
});

describe('нагрузка: сотни запросов разом', () => {
  it('600 запросов чтения с разных ролей: ни одного 5xx, отвечают все', async () => {
    const maid = await as(app, 'maid');
    const from = today;
    const to = plusDays(today, 31);
    const reads: [Api, string][] = [
      [reception, `/tape-chart?from=${from}&to=${to}`],
      [reception, '/dashboard'],
      [reception, '/bookings?limit=50'],
      [reception2, '/bookings?view=arrivals'],
      [senior, '/guests?limit=50'],
      [senior, '/cash'],
      [owner, '/reports/period'],
      [owner, '/reports/daily'],
      [owner, '/audit?limit=60'],
      [owner, '/staff'],
      [maid, '/housekeeping/tasks?assignee=me'],
      [maid, '/housekeeping/board'],
    ];
    const started = performance.now();
    const timings: number[] = [];
    const results = await Promise.all(
      Array.from({ length: 600 }, async (_, i) => {
        const [api, path] = reads[i % reads.length]!;
        const t0 = performance.now();
        const r = await api.get(path);
        timings.push(performance.now() - t0);
        return { path, status: r.status };
      }),
    );
    const total = performance.now() - started;
    const bad = results.filter((r) => r.status !== 200);
    expect(bad, JSON.stringify(bad.slice(0, 5))).toHaveLength(0);
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.floor(timings.length * 0.95)]!;
    console.log(`нагрузка: 600 запросов за ${Math.round(total)} мс, p50 ${Math.round(timings[300]!)} мс, p95 ${Math.round(p95)} мс`);
    expect(total).toBeLessThan(120_000);
  });

  it('чтение и запись вперемешку: брони, оплаты, доска, отчёты - без 5xx', async () => {
    await ensureShift(reception);
    const base = plusDays(today, 340);
    const roomIds: string[] = [];
    for (let i = 0; i < 6; i++) roomIds.push(await freeRoom(plusDays(base, i * 3), plusDays(base, i * 3 + 2), roomIds));
    const writes = roomIds.map((roomId, i) =>
      (i % 2 ? reception2 : reception)
        .post('/bookings', bookingBody(roomId, plusDays(base, i * 3), plusDays(base, i * 3 + 2), `Смесь${i}`), { 'Idempotency-Key': `mix-${i}-${Date.now()}` })
        .then(async (r) => {
          if (r.status !== 201) return [r.status];
          const pay = await reception.post('/payments', { bookingId: r.body.id, method: 'card', amount: 50_000 }, { 'Idempotency-Key': `mix-pay-${r.body.id}` });
          return [r.status, pay.status];
        }),
    );
    const reads = Array.from({ length: 120 }, (_, i) => owner.get(['/dashboard', '/housekeeping/board', '/reports/daily', `/tape-chart?from=${base}&to=${plusDays(base, 20)}`][i % 4]!).then((r) => [r.status]));
    const statuses = (await Promise.all([...writes, ...reads])).flat();
    expect(statuses.filter((s) => s >= 500)).toHaveLength(0);
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(roomIds.length);
  });
});
