import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, makeApp, tryLogin, type Api } from '../helpers.ts';

let app: FastifyInstance;
let owner: Api;

beforeAll(async () => {
  app = await makeApp();
  owner = await as(app, 'owner');
});

afterAll(async () => {
  await app.close();
});

/** Нанять и сразу войти: временный пароль сменить на свой. */
async function hireAndLogin(by: Api, body: Record<string, unknown>) {
  const res = await by.post('/staff', body, { 'Idempotency-Key': `hire-${body.login}-${Date.now()}` });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const temp = res.body.secrets.temporaryPassword as string;
  const api = await as(app, body.login as string, temp);
  const blocked = await api.get('/bookings');
  expect(blocked.status).toBe(403);
  expect(blocked.body.code).toBe('auth.password_change_required');
  expect((await api.post('/api/v1/me/password', { currentPassword: temp, newPassword: 'own-password-1' })).status).toBe(204);
  return { api: await as(app, body.login as string, 'own-password-1'), employee: res.body.employee };
}

describe('регистрация', () => {
  it('работает один раз: при заведённой гостинице - 409', async () => {
    const needed = await app.inject({ method: 'GET', url: '/api/v1/setup' });
    expect(needed.json()).toEqual({ needed: false });
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { hotelName: 'Вторая', fullName: 'Кто-то Другой', login: 'intruder', password: 'password-123', client: 'mobile' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('setup.done');
  });
});

describe('найм и права', () => {
  it('новая должность заводится прямо из найма, права - по разделам', async () => {
    const { api, employee } = await hireAndLogin(owner, {
      fullName: 'Портье Тестовый',
      login: 'porter.test',
      positionName: 'Ночной портье',
      rights: { sections: { bookings: 'view' }, powers: [] },
    });
    expect(employee.position.name).toBe('Ночной портье');
    expect(employee.mustChangePassword).toBe(true);
    const positions = (await owner.get('/positions')).body as { name: string; rights: { sections: Record<string, string> } }[];
    expect(positions.find((p) => p.name === 'Ночной портье')?.rights.sections.bookings).toBe('view');

    // «Видит» - читает, но не создаёт.
    expect((await api.get('/bookings')).status).toBe(200);
    const create = await api.post('/bookings', {});
    expect(create.status).toBe(403);
    // Отметить приход и сообщить о поломке может каждый.
    expect((await api.get('/attendance/me')).status).toBe(200);
  });

  it('права - из должности, если не переданы', async () => {
    const res = await owner.post('/staff', { fullName: 'Горничная Новая', login: 'maid.new', positionName: 'горничная' }, { 'Idempotency-Key': `maid-${Date.now()}` });
    expect(res.status).toBe(201);
    expect(res.body.employee.position.name).toBe('Горничная');
    expect(res.body.employee.rights.sections).toEqual({ cleaning: 'edit' });
    expect(res.body.secrets.pin).toMatch(/^\d{4}$/);
  });

  it('не выше своих: менеджер раздаёт только то, что есть у него', async () => {
    const { api: manager } = await hireAndLogin(owner, {
      fullName: 'Менеджер Персонала',
      login: 'hr.manager',
      positionName: 'Менеджер по персоналу',
      rights: { sections: { staff: 'edit', bookings: 'edit' }, powers: [] },
    });
    const ok = await manager.post('/staff', { fullName: 'Кассир Первый', login: 'clerk.one', rights: { sections: { bookings: 'view' }, powers: [] } }, { 'Idempotency-Key': `c1-${Date.now()}` });
    expect(ok.status).toBe(201);

    const above = await manager.post('/staff', { fullName: 'Кассир Второй', login: 'clerk.two', rights: { sections: { settings: 'edit' }, powers: [] } }, { 'Idempotency-Key': `c2-${Date.now()}` });
    expect(above.status).toBe(403);
    expect(above.body.code).toBe('staff.rights_above_own');

    const power = await manager.post('/staff', { fullName: 'Кассир Третий', login: 'clerk.three', rights: { sections: {}, powers: ['storno_closed'] } }, { 'Idempotency-Key': `c3-${Date.now()}` });
    expect(power.status).toBe(403);

    const admin = await manager.post('/staff', { fullName: 'Админ Самозванец', login: 'fake.admin', access: 'admin' }, { 'Idempotency-Key': `c4-${Date.now()}` });
    expect(admin.status).toBe(403);
    expect(admin.body.code).toBe('staff.admin');

    const list = (await owner.get('/staff')).body as { id: string; login: string }[];
    const ownerId = list.find((s) => s.login === 'owner')!.id;
    const touchOwner = await manager.patch(`/staff/${ownerId}`, { isActive: false });
    expect(touchOwner.status).toBe(403);
    expect(touchOwner.body.code).toBe('staff.owner');

    // Себе права не меняют.
    const meId = list.find((s) => s.login === 'hr.manager')!.id;
    const self = await manager.patch(`/staff/${meId}`, { rights: { sections: { staff: 'edit', bookings: 'edit', settings: 'edit' }, powers: [] } });
    expect(self.status).toBe(409);
    expect(self.body.code).toBe('staff.self');
  });

  it('блокировка и увольнение закрывают вход; возврат - с новым временным паролем', async () => {
    const { employee } = await hireAndLogin(owner, { fullName: 'Уходящий Сотрудник', login: 'leaving', positionName: 'Техник' });
    expect((await owner.patch(`/staff/${employee.id}`, { isActive: false })).status).toBe(200);
    expect((await tryLogin(app, 'leaving', 'own-password-1')).status).toBe(401);
    expect((await owner.patch(`/staff/${employee.id}`, { isActive: true })).status).toBe(200);
    expect((await tryLogin(app, 'leaving', 'own-password-1')).status).toBe(200);

    expect((await owner.del(`/staff/${employee.id}`, { reason: 'Уволился по собственному желанию' })).status).toBe(204);
    expect((await tryLogin(app, 'leaving', 'own-password-1')).status).toBe(401);
    const active = (await owner.get('/staff')).body as { id: string }[];
    expect(active.some((s) => s.id === employee.id)).toBe(false);
    // Так спрашивает веб: строка «false» - это false, а не «непустая строка».
    const activeExplicit = (await owner.get('/staff?archived=false')).body as { id: string }[];
    expect(activeExplicit.some((s) => s.id === employee.id)).toBe(false);
    expect(activeExplicit.length).toBeGreaterThan(5);
    const archived = (await owner.get('/staff?archived=true')).body as { id: string }[];
    expect(archived.some((s) => s.id === employee.id)).toBe(true);

    const back = await owner.post(`/staff/${employee.id}/restore`);
    expect(back.status).toBe(200);
    expect(back.body.employee.mustChangePassword).toBe(true);
    expect((await tryLogin(app, 'leaving', back.body.secrets.temporaryPassword)).status).toBe(200);
  });

  it('права должности - всем, кто на ней работает', async () => {
    const position = (await owner.post('/positions', { name: 'Консьерж', rights: { sections: { guests: 'view' }, powers: [] } })).body;
    const a = await owner.post('/staff', { fullName: 'Консьерж Первый', login: 'concierge.1', positionId: position.id }, { 'Idempotency-Key': `k1-${Date.now()}` });
    const b = await owner.post('/staff', { fullName: 'Консьерж Второй', login: 'concierge.2', positionId: position.id }, { 'Idempotency-Key': `k2-${Date.now()}` });
    expect(a.body.employee.rights.sections).toEqual({ guests: 'view' });

    await owner.patch(`/positions/${position.id}`, { rights: { sections: { guests: 'edit', bookings: 'view' }, powers: [] } });
    // Сама правка должности людей не трогает.
    expect((await owner.get(`/staff/${b.body.employee.id}`)).body.rights.sections).toEqual({ guests: 'view' });
    const applied = await owner.post(`/positions/${position.id}/apply`);
    expect(applied.body.updated).toBe(2);
    expect((await owner.get(`/staff/${b.body.employee.id}`)).body.rights.sections).toEqual({ bookings: 'view', guests: 'edit' });

    // Должность с людьми не удаляется.
    const del = await owner.del(`/positions/${position.id}`);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('position.in_use');
  });

  it('спеццену утверждает только тот, у кого есть это полномочие', async () => {
    const dir = (await owner.get('/staff/directory')).body as { fullName: string; canApproveSpecialPrice: boolean; position: string | null }[];
    const approvers = dir.filter((d) => d.canApproveSpecialPrice);
    expect(approvers.length).toBeGreaterThan(0);
    expect(approvers.every((d) => d.position === 'Управляющий' || d.position === 'Администратор')).toBe(true);
  });
});

describe('подбор пароля и PIN', () => {
  it('после пяти неверных паролей - пауза только этой учётной записи, соседи с того же адреса входят', async () => {
    for (let i = 0; i < 5; i++) expect((await tryLogin(app, 'callcenter2', 'не-тот-пароль')).status).toBe(401);
    const paused = await tryLogin(app, 'callcenter2', 'demo12345');
    expect(paused.status).toBe(429);
    expect(paused.body.code).toBe('auth.too_many_attempts');
    expect(paused.body.detail).toMatch(/через \d+ с/);
    // Тот же адрес гостиницы, другой сотрудник - входит без помех.
    expect((await tryLogin(app, 'callcenter', 'demo12345')).status).toBe(200);
  });

  it('планшет: подбор PIN ставит паузу логину, остальные отмечаются', async () => {
    const pin = (login: string, value: string) =>
      app.inject({ method: 'POST', url: '/api/v1/kiosk/clock', payload: { propertyId: owner.propertyId, login, pin: value } });
    for (let i = 0; i < 5; i++) expect((await pin('events', '0000')).statusCode).toBe(401);
    const paused = await pin('events', '1234');
    expect(paused.statusCode).toBe(429);
    expect((await pin('night', '1234')).statusCode).toBe(200);
  });
});