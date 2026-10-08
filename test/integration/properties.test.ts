import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, makeApp, plusDays, type Api } from '../helpers.ts';

/**
 * Сеть гостиниц: владелец добавляет вторую, у каждой свои номера, касса,
 * люди и журнал; гости и компании - общие. Чужая гостиница закрыта целиком:
 * ни списком, ни по прямому id записи из соседней.
 */
let app: FastifyInstance;
let owner: Api;
let senior: Api;
let second: string;

beforeAll(async () => {
  app = await makeApp();
  owner = await as(app, 'owner');
  senior = await as(app, 'senior');
});

afterAll(async () => {
  await app.close();
});

describe('сеть гостиниц', () => {
  it('добавить гостиницу может только владелец', async () => {
    const denied = await senior.post('/api/v1/properties', { name: 'Не моя гостиница' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('property.create_forbidden');
    const tooShort = await owner.post('/api/v1/properties', { name: 'А' });
    expect(tooShort.status).toBe(400);
  });

  it('владелец добавляет гостиницу с правилами первой; второе такое же имя - отказ', async () => {
    const created = await owner.post('/api/v1/properties', { name: 'Bizdin Auyl Шымкент', copyFrom: owner.propertyId, address: 'Шымкент, пр. Тауке хана, 1' });
    expect(created.status).toBe(201);
    second = created.body.id;
    const dup = await owner.post('/api/v1/properties', { name: '  bizdin auyl шымкент ' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('property.name_taken');

    const me = await owner.get('/api/v1/me');
    const mine = me.body.properties.find((p: { id: string }) => p.id === second);
    expect(mine).toMatchObject({ name: 'Bizdin Auyl Шымкент', access: 'owner', currency: 'KZT', timezone: 'Asia/Almaty' });

    const a = (await owner.get('')).body;
    const b = (await owner.get(`/api/v1/properties/${second}`)).body;
    expect(b.settings).toEqual(a.settings);
    expect(b.checkInTime).toBe(a.checkInTime);
    expect(b.address).toBe('Шымкент, пр. Тауке хана, 1');
  });

  it('новая гостиница пустая, но рабочая: касса, доска, отчёты отвечают', async () => {
    const base = `/api/v1/properties/${second}`;
    expect((await owner.get(`${base}/rooms`)).body).toEqual([]);
    expect((await owner.get(`${base}/room-types`)).body).toEqual([]);
    const cash = await owner.get(`${base}/cash`);
    expect(cash.status).toBe(200);
    expect(cash.body.shift).toBeNull();
    for (const path of ['/dashboard', '/housekeeping/board', '/reports/daily', '/reports/period', '/tape-chart', '/staff', '/audit']) {
      const r = await owner.get(`${base}${path}`);
      expect(r.status, path).toBe(200);
    }
    const staff = (await owner.get(`${base}/staff`)).body as { login: string }[];
    expect(staff.map((s) => s.login)).toEqual(['owner']);
    const audit = (await owner.get(`${base}/audit`)).body;
    expect(audit.items.map((i: { action: string }) => i.action)).toContain('property.create');
  });

  it('сотрудник первой гостиницы во вторую не попадает', async () => {
    const base = `/api/v1/properties/${second}`;
    for (const path of ['', '/bookings', '/cash', '/staff', '/rooms', '/guests', '/reports/daily']) {
      const r = await senior.get(`${base}${path}`);
      expect(r.status, path).toBe(403);
      expect(r.body.code).toBe('property.forbidden');
    }
    const me = await senior.get('/api/v1/me');
    expect(me.body.properties.map((p: { id: string }) => p.id)).not.toContain(second);
  });

  it('запись первой гостиницы по прямому id из второй не достать и не поменять', async () => {
    const base = `/api/v1/properties/${second}`;
    const room = (await owner.get('/rooms')).body[0];
    const type = (await owner.get('/room-types')).body[0];
    const plan = (await owner.get('/rate-plans')).body[0];
    const booking = (await owner.get('/bookings?limit=1')).body.items[0];

    expect((await owner.patch(`${base}/rooms/${room.id}`, { note: 'чужой' }, { 'If-Match': `"${room.version}"` })).status).toBe(404);
    expect((await owner.patch(`${base}/room-types/${type.id}`, { name: 'чужой' })).status).toBe(404);
    expect((await owner.get(`${base}/bookings/${booking.id}`)).status).toBe(404);
    expect((await owner.post(`${base}/rooms/${room.id}/hk-status`, { status: 'dirty' })).status).toBe(404);
    const today = (await owner.get('')).body.businessDate;
    const foreignBooking = await owner.post(
      `${base}/bookings`,
      { guest: { lastName: 'Тест', firstName: 'Чужой' }, roomId: room.id, arrival: plusDays(today, 40), departure: plusDays(today, 41), ratePlanId: plan.id, source: 'phone' },
      { 'Idempotency-Key': `foreign-${Date.now()}` },
    );
    expect(foreignBooking.status).toBe(404);
    // Номер первой гостиницы не изменился.
    const after = (await owner.get('/rooms')).body.find((r: { id: string }) => r.id === room.id);
    expect(after.note).toBe(room.note);
  });

  it('во второй гостинице заводятся свои номера и тарифы, бронь проходит', async () => {
    const base = `/api/v1/properties/${second}`;
    const type = await owner.post(`${base}/room-types`, { code: 'STD', name: 'Стандарт', baseOccupancy: 2, maxOccupancy: 3 });
    expect(type.status).toBe(201);
    const room = await owner.post(`${base}/rooms`, { number: '101', roomTypeId: type.body.id, floor: 1 });
    expect(room.status).toBe(201);
    // Номер 101 есть и в первой гостинице: номера уникальны внутри гостиницы, не сети.
    expect((await owner.get('/rooms')).body.some((r: { number: string }) => r.number === '101')).toBe(true);
    const plan = await owner.post(`${base}/rate-plans`, { code: 'BAR', name: 'Базовый', kind: 'standard' });
    expect(plan.status).toBe(201);
    const today = (await owner.get(`${base}`)).body.businessDate;
    const price = await owner.post(`${base}/rate-plans/${plan.body.id}/prices`, {
      roomTypeId: type.body.id,
      label: 'Базовая',
      validFrom: today,
      validTo: plusDays(today, 365),
      amount: 2_000_000,
    });
    expect(price.status).toBe(201);
    const booking = await owner.post(
      `${base}/bookings`,
      { guest: { lastName: 'Сетевой', firstName: 'Гость' }, roomId: room.body.id, arrival: plusDays(today, 3), departure: plusDays(today, 5), ratePlanId: plan.body.id, source: 'phone' },
      { 'Idempotency-Key': `net-${Date.now()}` },
    );
    expect(booking.status).toBe(201);
    expect(booking.body.accommodationTotal).toBe(4_000_000);
    // Нумерация броней своя у каждой гостиницы: первая бронь новой - 1001.
    expect(booking.body.number).toBe(1001);

    // Гость сети виден из первой гостиницы: база гостей общая.
    const found = await owner.get(`/guests?q=${encodeURIComponent('Сетевой')}`);
    expect(found.status).toBe(200);
    expect(found.body.items.some((g: { fullName: string }) => g.fullName.startsWith('Сетевой'))).toBe(true);
    // А бронь - нет: брони у каждой гостиницы свои.
    const list = await owner.get(`/bookings?q=${encodeURIComponent('Сетевой')}`);
    expect(list.body.items).toHaveLength(0);
  });
});
