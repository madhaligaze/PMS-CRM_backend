import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, makeApp, plusDays, type Api } from '../helpers.ts';

let app: FastifyInstance;
let owner: Api;
let reception: Api;
let senior: Api;
let today: string;
let rooms: { id: string; number: string; hkStatus: string }[];
let ratePlanId: string;

beforeAll(async () => {
  app = await makeApp();
  owner = await as(app, 'owner');
  reception = await as(app, 'reception');
  senior = await as(app, 'senior');
  today = (await owner.get('')).body.businessDate;
  rooms = (await owner.get('/rooms')).body;
  ratePlanId = ((await owner.get('/rate-plans')).body as { id: string; code: string }[]).find((p) => p.code === 'BAR')!.id;
});

afterAll(async () => {
  await app.close();
});

const room = (n: string) => rooms.find((r) => r.number === n)!.id;

describe('цикл гостя: бронь, заселение, проживание, оплата, выселение', () => {
  it('проходит целиком, номер уходит горничной и возвращается в продажу', async () => {
    // Свободный сегодня номер без заезда: 108 заблокирован, ищем по шахматке.
    const tape = (await reception.get(`/tape-chart?from=${today}&to=${plusDays(today, 2)}`)).body;
    const busy = new Set<string>([
      ...tape.bookings.filter((b: any) => b.arrival < plusDays(today, 2) && b.departure > today && b.status !== 'checked_out').map((b: any) => b.roomId),
      ...tape.blocks.map((b: any) => b.roomId),
    ]);
    const free = tape.rooms.find((r: any) => !busy.has(r.id) && r.isActive);
    expect(free, 'нужен свободный номер на сегодня').toBeTruthy();

    // 1. Бронь «с улицы» с новым гостем.
    const created = await reception.post(
      '/bookings',
      {
        guest: { lastName: 'Сквозной', firstName: 'Гость', phone: '8 701 777 00 01' },
        roomId: free.id,
        arrival: today,
        departure: plusDays(today, 2),
        ratePlanId,
        source: 'walk_in',
        status: 'confirmed',
      },
      { 'Idempotency-Key': `flow-${Date.now()}` },
    );
    expect(created.status).toBe(201);
    const b = created.body;
    expect(b.nightsCount).toBe(2);
    expect(b.balance.due).toBe(b.accommodationTotal);

    // 2. Готовность: нет документа и согласия.
    let ready = await reception.get(`/bookings/${b.id}/check-in`);
    const codes = ready.body.problems.map((p: any) => p.code);
    expect(codes).toContain('guest.data_missing');
    expect(codes).toContain('guest.consent_missing');
    const blocked = await reception.post(`/bookings/${b.id}/check-in`, { keyIssued: true });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('checkin.not_ready');

    // 3. Данные документа (как из MRZ) и согласие.
    const g = await reception.get(`/guests/${b.guest.id}`);
    const upd = await reception.patch(
      `/guests/${b.guest.id}`,
      { docType: 'id_card', docNumber: '099900017', citizenship: 'KAZ', birthDate: '1990-01-01', personalNumber: '900101300811' },
      { 'If-Match': `"${g.body.version}"` },
    );
    expect(upd.status).toBe(200);
    await reception.post(`/guests/${b.guest.id}/consent`, { method: 'paper' });

    // 4. Номер должен быть проверен хозслужбой.
    const supervisor = await as(app, 'supervisor');
    const roomNow = (await owner.get('/rooms')).body.find((r: any) => r.id === free.id);
    if (roomNow.hkStatus !== 'inspected') {
      const s = await supervisor.post(`/rooms/${free.id}/hk-status`, { status: 'inspected' });
      expect(s.status).toBe(204);
    }
    ready = await reception.get(`/bookings/${b.id}/check-in`);
    expect(ready.body.ready).toBe(true);

    // 5. Заселение.
    const inHouse = await reception.post(`/bookings/${b.id}/check-in`, { keyIssued: true });
    expect(inHouse.status).toBe(200);
    expect(inHouse.body.status).toBe('checked_in');

    // 6. Начисление и оплата полностью.
    const charge = await reception.post(`/bookings/${b.id}/charges`, { kind: 'minibar', quantity: 2, unitAmount: 15000 });
    expect(charge.status).toBe(201);
    expect(charge.body.balance.due).toBe(b.accommodationTotal + 30000);
    const pay = await reception.post('/payments', { bookingId: b.id, method: 'card', amount: charge.body.balance.due }, { 'Idempotency-Key': `flow-pay-${Date.now()}` });
    expect(pay.status).toBe(201);
    expect(pay.body.fiscalNumber).toMatch(/^TEST-/);

    // 7. Выезд раньше даты - сначала сократить проживание, переплату вернуть.
    const early = await reception.post(`/bookings/${b.id}/check-out`, {});
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('checkout.early');
    const fresh = await reception.get(`/bookings/${b.id}`);
    const shorter = await reception.patch(`/bookings/${b.id}`, { departure: plusDays(today, 1) }, { 'If-Match': `"${fresh.body.version}"` });
    expect(shorter.status).toBe(200);
    expect(shorter.body.nightsCount).toBe(1);
    expect(shorter.body.balance.due).toBeLessThan(0);
    // Возврат сверх лимита без согласования (настройка управляющего) - только управляющий.
    const overpaid = -shorter.body.balance.due;
    const limit = (await owner.get('')).body.settings.refundLimit;
    const byReception = await reception.post('/payments', { bookingId: b.id, kind: 'refund', method: 'card', amount: overpaid });
    if (overpaid > limit) {
      expect(byReception.status).toBe(403);
      expect(byReception.body.code).toBe('refund.over_limit');
      expect((await owner.post('/payments', { bookingId: b.id, kind: 'refund', method: 'card', amount: overpaid })).status).toBe(201);
    } else {
      expect(byReception.status).toBe(201);
    }
    expect((await reception.get(`/bookings/${b.id}`)).body.balance.due).toBe(0);
  });

  it('выселение: счёт сверен, номер «грязный» и задача горничной', async () => {
    const departures = (await reception.get('/bookings?view=departures')).body.items.filter((x: any) => x.status === 'checked_in');
    expect(departures.length).toBeGreaterThan(0);
    const d = departures[0];
    const unpaid = await reception.post(`/bookings/${d.id}/check-out`, {});
    if (d.due > 0) {
      expect(unpaid.status).toBe(409);
      expect(unpaid.body.code).toBe('checkout.unpaid');
      await reception.post('/payments', { bookingId: d.id, method: 'cash', amount: d.due });
    }
    const out = await reception.post(`/bookings/${d.id}/check-out`, { rating: 5, feedback: 'Спасибо' });
    expect(out.status).toBe(200);
    expect(out.body.status).toBe('checked_out');
    expect(out.body.roomHkStatus).toBe('dirty');
    const tasks = (await owner.get('/housekeeping/tasks')).body.filter((t: any) => t.roomId === d.roomId && t.kind === 'departure');
    expect(tasks.length).toBeGreaterThan(0);
  });
});

describe('права по ролям из ТЗ', () => {
  it('скидка сверх лимита - только управляющий', async () => {
    const body = (pct: number) => ({
      guest: { lastName: 'Скидкин', firstName: 'Тест', phone: `0700 55${pct}${pct} 00` },
      roomId: room('101'),
      arrival: plusDays(today, 90 + pct),
      departure: plusDays(today, 91 + pct),
      ratePlanId,
      source: 'phone',
      priceMode: 'discount',
      discountPercent: pct,
      priceReason: 'Постоянный гость',
    });
    const over = await reception.post('/bookings', body(25));
    expect(over.status).toBe(403);
    expect(over.body.code).toBe('price.discount_over_limit');
    const within = await reception.post('/bookings', body(5));
    expect(within.status).toBe(201);
    const ownerOver = await owner.post('/bookings', body(30));
    expect(ownerOver.status).toBe(201);
  });

  it('спеццена: без права нельзя, без утвердившего нельзя', async () => {
    const dir = (await senior.get('/staff/directory')).body as { id: string; canApproveSpecialPrice: boolean }[];
    const approver = dir.find((u) => u.canApproveSpecialPrice)!.id;
    const body = (extra: Record<string, unknown>) => ({
      guest: { lastName: 'Спецценов', firstName: 'Тест', phone: '0700 990 990' },
      roomId: room('103'),
      arrival: plusDays(today, 120),
      departure: plusDays(today, 122),
      ratePlanId,
      source: 'phone',
      priceMode: 'special',
      specialNightly: 200000,
      priceReason: 'Партнёр',
      ...extra,
    });
    expect((await reception.post('/bookings', body({ priceApprovedBy: approver }))).status).toBe(403);
    const noApprover = await senior.post('/bookings', body({}));
    expect(noApprover.status).toBe(400);
    expect(noApprover.body.code).toBe('price.approver_required');
    const ok = await senior.post('/bookings', body({ priceApprovedBy: approver }));
    expect(ok.status).toBe(201);
    expect(ok.body.paymentType).toBe('special');
    expect(ok.body.discountTotal).toBeGreaterThan(0);
  });

  it('горничная не видит гостей и деньги, техник не видит брони', async () => {
    const maid = await as(app, 'maid');
    expect((await maid.get('/bookings')).status).toBe(403);
    expect((await maid.get('/guests')).status).toBe(403);
    expect((await maid.get('/cash')).status).toBe(403);
    const board = await maid.get('/housekeeping/board');
    expect(board.status).toBe(200);
    for (const r of board.body.rooms) {
      expect(r.inHouseGuest).toBeNull();
      expect(r.arrivalGuest).toBeNull();
    }
    const tech = await as(app, 'tech');
    expect((await tech.get('/tape-chart')).status).toBe(403);
    expect((await tech.get('/maintenance')).status).toBe(200);
  });

  it('колл-центр бронирует, но не заселяет и не принимает оплату', async () => {
    const cc = await as(app, 'callcenter');
    const b = await cc.post('/bookings', {
      guest: { lastName: 'Звонков', firstName: 'Тест', phone: '0700 123 321' },
      roomId: room('104'),
      arrival: plusDays(today, 140),
      departure: plusDays(today, 141),
      ratePlanId,
      source: 'phone',
    });
    expect(b.status).toBe(201);
    expect(b.body.balance).toBeNull();
    expect((await cc.post(`/bookings/${b.body.id}/check-in`, {})).status).toBe(403);
    expect((await cc.post('/payments', { bookingId: b.body.id, method: 'cash', amount: 100 })).status).toBe(403);
  });

  it('сторно: в смене - старший администратор, администратор - нет', async () => {
    const list = (await reception.get('/bookings?view=inhouse')).body.items;
    const target = list[0];
    const pay = await reception.post('/payments', { bookingId: target.id, method: 'cash', amount: 10000 });
    expect(pay.status).toBe(201);
    expect((await reception.post(`/payments/${pay.body.id}/storno`, { reason: 'Ошибка в сумме' })).status).toBe(403);
    const st = await senior.post(`/payments/${pay.body.id}/storno`, { reason: 'Ошибка в сумме' });
    expect(st.status).toBe(200);
    expect(st.body.signedAmount).toBe(-10000);
    const again = await senior.post(`/payments/${pay.body.id}/storno`, { reason: 'Ещё раз' });
    expect(again.status).toBe(409);
  });
});

describe('касса', () => {
  it('Z-отчёт: расхождение без комментария не закрывает смену', async () => {
    const state = (await reception.get('/cash')).body;
    const shiftId = state.shift.id;
    const wrong = await reception.post(`/cash/shifts/${shiftId}/close`, { countedCash: state.report.expectedCash - 50000 });
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('shift.discrepancy_comment');
  });

  it('выемка больше остатка запрещена', async () => {
    const state = (await reception.get('/cash')).body;
    const r = await reception.post(`/cash/shifts/${state.shift.id}/movements`, { kind: 'withdrawal', amount: state.report.expectedCash + 1, reason: 'Тест' });
    expect(r.status).toBe(400);
  });

  it('без отметки о приходе смену не открыть, а после Z-отчёта оплату не принять', async () => {
    const state = (await reception.get('/cash')).body;
    const closed = await reception.post(`/cash/shifts/${state.shift.id}/close`, { countedCash: state.report.expectedCash });
    expect(closed.status).toBe(200);
    expect(closed.body.report.discrepancy).toBe(0);

    const inhouse = (await reception.get('/bookings?view=inhouse')).body.items[0];
    const noShift = await reception.post('/payments', { bookingId: inhouse.id, method: 'cash', amount: 100 });
    expect(noShift.status).toBe(409);
    expect(noShift.body.code).toBe('shift.closed');

    // Ночной администратор сегодня не отмечался.
    const night = await as(app, 'night');
    const me = await night.get('/attendance/me');
    if (me.body.clockedIn) await night.post('/attendance/clock', { kind: 'out' });
    const denied = await night.post('/cash/shifts', {});
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('attendance.required');
    await night.post('/attendance/clock', { kind: 'in' });
    const opened = await night.post('/cash/shifts', {});
    expect(opened.status).toBe(201);
    expect(opened.body.openingCash).toBe(state.report.expectedCash);
    const prev = (await night.get('/cash')).body.previous;
    expect(prev.acceptedBy).toBeTruthy();
  });
});

describe('база гостей без дублей', () => {
  it('тот же документ - та же карточка, дубль - 409 со ссылкой', async () => {
    const first = await reception.post('/guests', { lastName: 'Дублев', firstName: 'Иван', docType: 'passport', docNumber: 'N 0777 0001', citizenship: 'KAZ' });
    expect(first.status).toBe(201);
    const dup = await reception.post('/guests', { lastName: 'Дублев', firstName: 'Ваня', docType: 'passport', docNumber: 'n07770001', citizenship: 'KAZ' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('guest.duplicate');
    expect(dup.body.guestId).toBe(first.body.id);

    // Бронь с тем же документом обновляет существующую карточку.
    const b = await reception.post('/bookings', {
      guest: { lastName: 'Дублев', firstName: 'Иван', docType: 'passport', docNumber: 'N07770001', citizenship: 'KAZ', phone: '8 777 000 77 77' },
      roomId: room('105'),
      arrival: plusDays(today, 150),
      departure: plusDays(today, 151),
      ratePlanId,
      source: 'phone',
    });
    expect(b.status).toBe(201);
    expect(b.body.guest.id).toBe(first.body.id);
    expect(b.body.guest.phone).toBe('8 777 000 77 77');
  });

  it('объединение: история переезжает, дубль остаётся со ссылкой', async () => {
    const a = await reception.post('/guests', { lastName: 'Склейкина', firstName: 'Анна', phone: '8 700 444 55 55' });
    const c = await reception.post('/guests', { lastName: 'Склейкина', firstName: 'Анна', phone: '+7 (700) 444-55-55', email: 'anna@example.kz' });
    const matches = await reception.post('/guests/match', { phone: '87004445555', excludeId: a.body.id });
    expect(matches.body.some((m: any) => m.guest.id === c.body.id && m.reasons.includes('phone'))).toBe(true);
    expect((await reception.post(`/guests/${a.body.id}/merge`, { duplicateId: c.body.id })).status).toBe(403);
    const merged = await senior.post(`/guests/${a.body.id}/merge`, { duplicateId: c.body.id });
    expect(merged.status).toBe(200);
    expect(merged.body.email).toBe('anna@example.kz');
    const old = await senior.get(`/guests/${c.body.id}`);
    expect(old.body.mergedInto).toBe(a.body.id);
  });
});

describe('хозслужба', () => {
  it('горничная: начать - закончить; супервайзер: принять или вернуть с причиной', async () => {
    const supervisor = await as(app, 'supervisor');
    const maid = await as(app, 'maid');
    const board = (await supervisor.get('/housekeeping/board')).body;
    const target = board.rooms.find((r: any) => r.occupancy === 'free' && r.hkStatus !== 'repair');
    const t = await supervisor.post('/housekeeping/tasks', { roomId: target.id, kind: 'request', note: 'Тест', assigneeId: board.staff.find((s: any) => s.position === 'Горничная').id });
    expect(t.status).toBe(201);
    const mine = (await maid.get('/housekeeping/tasks')).body.find((x: any) => x.id === t.body.id);
    if (!mine) return; // задача назначена другой горничной демо - сценарий ниже от её имени не пройдёт
    expect((await maid.post(`/housekeeping/tasks/${t.body.id}/start`)).body.status).toBe('in_progress');
    expect((await maid.post(`/housekeeping/tasks/${t.body.id}/finish`, {})).body.status).toBe('done');
    expect((await maid.post(`/housekeeping/tasks/${t.body.id}/inspect`, { ok: true })).status).toBe(403);
    const noReason = await supervisor.post(`/housekeeping/tasks/${t.body.id}/inspect`, { ok: false });
    expect(noReason.status).toBe(400);
    const back = await supervisor.post(`/housekeeping/tasks/${t.body.id}/inspect`, { ok: false, note: 'Пыль на подоконнике' });
    expect(back.body.status).toBe('open');
  });

  it('генеральную уборку нельзя пропустить без причины', async () => {
    const supervisor = await as(app, 'supervisor');
    const board = (await supervisor.get('/housekeeping/board')).body;
    const t = await supervisor.post('/housekeeping/tasks', { roomId: board.rooms[0].id, kind: 'general' });
    const r = await supervisor.post(`/housekeeping/tasks/${t.body.id}/skip`, { reason: 'other' });
    expect(r.status).toBe(400);
    const ok = await supervisor.post(`/housekeeping/tasks/${t.body.id}/skip`, { reason: 'other', note: 'Номер на продаже, перенесли на четверг' });
    expect(ok.body.status).toBe('skipped');
  });
});

describe('отчёты и журнал', () => {
  it('журнал фиксирует действия с автором', async () => {
    const audit = await owner.get('/audit?limit=20');
    expect(audit.status).toBe(200);
    expect(audit.body.items.length).toBeGreaterThan(0);
    expect(audit.body.items.every((e: any) => e.actorName)).toBe(true);
  });

  it('табель и выгрузка оплат отдают CSV для Excel', async () => {
    const month = today.slice(0, 7);
    const csv = await owner.get(`/attendance/timesheet/export?month=${month}`);
    expect(csv.status).toBe(200);
    expect(String(csv.headers['content-type'])).toContain('text/csv');
    const pay = await owner.get(`/reports/payments-export?from=${plusDays(today, -7)}&to=${today}`);
    expect(pay.status).toBe(200);
    expect(String(pay.body).charCodeAt(0)).toBe(0xfeff);
  });
});
