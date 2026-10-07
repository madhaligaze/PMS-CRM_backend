import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, makeApp, plusDays, type Api } from '../helpers.ts';

let app: FastifyInstance;
let owner: Api;
let today: string;
let roomId: string;
let ratePlanId: string;

beforeAll(async () => {
  app = await makeApp();
  owner = await as(app, 'owner');
  today = (await owner.get('')).body.businessDate;
  const rooms = (await owner.get('/rooms')).body as { id: string; number: string }[];
  roomId = rooms.find((r) => r.number === '102')!.id;
  ratePlanId = ((await owner.get('/rate-plans')).body as { id: string; code: string }[]).find((p) => p.code === 'BAR')!.id;
});

afterAll(async () => {
  await app.close();
});

function booking(arrival: string, departure: string, extra: Record<string, unknown> = {}) {
  return {
    guest: { lastName: 'Инвариантов', firstName: 'Тест', phone: `0700 ${Math.floor(100000 + Math.random() * 899999)}` },
    roomId,
    arrival,
    departure,
    ratePlanId,
    source: 'phone',
    ...extra,
  };
}

describe('двойная бронь невозможна', () => {
  it('пересечение дат одного номера - 409 с тем, что занимает номер', async () => {
    const a = await owner.post('/bookings', booking(plusDays(today, 40), plusDays(today, 43)));
    expect(a.status).toBe(201);
    const b = await owner.post('/bookings', booking(plusDays(today, 42), plusDays(today, 45)));
    expect(b.status).toBe(409);
    expect(b.body.code).toBe('room.occupied');
    expect(b.body.conflict.number).toBe(a.body.number);
  });

  it('выезд одного в день заезда другого - не пересечение', async () => {
    const b = await owner.post('/bookings', booking(plusDays(today, 43), plusDays(today, 44)));
    expect(b.status).toBe(201);
  });

  it('отмена освобождает номер', async () => {
    const a = await owner.post('/bookings', booking(plusDays(today, 50), plusDays(today, 52)));
    const c = await owner.post(`/bookings/${a.body.id}/cancel`, { reason: 'Тест' });
    expect(c.body.status).toBe('cancelled');
    const b = await owner.post('/bookings', booking(plusDays(today, 50), plusDays(today, 52)));
    expect(b.status).toBe(201);
  });

  it('блокировка ремонта не пересекается с бронью', async () => {
    const blk = await owner.post('/room-blocks', { roomId, startsOn: plusDays(today, 41), endsOn: plusDays(today, 42), reason: 'Тест' });
    expect(blk.status).toBe(409);
    expect(blk.body.code).toBe('room.occupied');
  });

  it('перенос брони на занятые даты - 409, бронь не меняется', async () => {
    const a = await owner.post('/bookings', booking(plusDays(today, 60), plusDays(today, 61)));
    const moved = await owner.patch(`/bookings/${a.body.id}`, { arrival: plusDays(today, 40), departure: plusDays(today, 41) }, { 'If-Match': `"${a.body.version}"` });
    expect(moved.status).toBe(409);
    const fresh = await owner.get(`/bookings/${a.body.id}`);
    expect(fresh.body.arrival).toBe(plusDays(today, 60));
  });
});

describe('ничего не удаляется бесследно', () => {
  it('журнал нельзя изменить или очистить даже в обход API', async () => {
    const db = app.deps.db;
    await expect(db.execute(sql`update audit_log set actor_name = 'x'`)).rejects.toThrow();
    await expect(db.execute(sql`delete from audit_log`)).rejects.toThrow();
    await expect(db.execute(sql`truncate audit_log`)).rejects.toThrow();
  });

  it('проведённую оплату нельзя изменить или удалить', async () => {
    const db = app.deps.db;
    await expect(db.execute(sql`update payments set amount = amount + 1 where id = (select id from payments limit 1)`)).rejects.toThrow();
    await expect(db.execute(sql`delete from payments where id = (select id from payments limit 1)`)).rejects.toThrow();
  });

  it('закрытую Z-отчётом смену нельзя изменить, оплату в неё - провести', async () => {
    const db = app.deps.db;
    await expect(db.execute(sql`update cash_shifts set counted_cash = 0 where status = 'closed'`)).rejects.toThrow();
    await expect(
      db.execute(sql`
        insert into payments (id, property_id, number, shift_id, kind, method, payment_type, amount, created_by)
        select gen_random_uuid(), property_id, 999999, id, 'payment', 'cash', 'cash', 100, opened_by from cash_shifts where status = 'closed' limit 1
      `),
    ).rejects.toThrow();
  });

  it('удалить бронь API не умеет: только отмена с причиной', async () => {
    const r = await app.inject({ method: 'DELETE', url: `/api/v1/properties/${owner.propertyId}/bookings/${'0'.repeat(8)}-0000-0000-0000-000000000000`, headers: { authorization: `Bearer ${owner.token}` } });
    expect(r.statusCode).toBe(404);
    const noReason = await owner.post(`/bookings/${'0'.repeat(8)}-0000-0000-0000-000000000000/cancel`, { reason: '' });
    expect(noReason.status).toBe(400);
  });
});

describe('одновременная правка', () => {
  it('правка по устаревшей версии - 412, без версии - 428', async () => {
    const a = await owner.post('/bookings', booking(plusDays(today, 70), plusDays(today, 72)));
    const ok = await owner.patch(`/bookings/${a.body.id}`, { comment: 'раз' }, { 'If-Match': `"${a.body.version}"` });
    expect(ok.status).toBe(200);
    const stale = await owner.patch(`/bookings/${a.body.id}`, { comment: 'два' }, { 'If-Match': `"${a.body.version}"` });
    expect(stale.status).toBe(412);
    const none = await owner.patch(`/bookings/${a.body.id}`, { comment: 'три' });
    expect(none.status).toBe(428);
  });

  it('Idempotency-Key: повтор не создаёт вторую бронь', async () => {
    const body = booking(plusDays(today, 80), plusDays(today, 81));
    const key = `test-${Date.now()}`;
    const a = await owner.post('/bookings', body, { 'Idempotency-Key': key });
    const b = await owner.post('/bookings', body, { 'Idempotency-Key': key });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(b.headers['idempotent-replayed']).toBe('true');
    const other = await owner.post('/bookings', { ...body, comment: 'другое тело' }, { 'Idempotency-Key': key });
    expect(other.status).toBe(422);
  });
});
