import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { can } from '../../core/context.ts';
import { ctxOf } from '../../core/guards.ts';
import { Problem } from '../../core/http.ts';
import { cashShifts, payments } from '../../db/schema/index.ts';
import { forbidden, notFound } from '../../lib/errors.ts';
import { PageQuery, pageSchema } from '../../lib/pagination.ts';
import { CashReportDto, CashStateDto, ChargeKind, FolioDto, PaymentDto, PaymentKind, PaymentMethod, ShiftDto } from './schemas.ts';
import * as svc from './service.ts';

const P = z.object({ propertyId: z.uuid() });
const PI = P.extend({ id: z.uuid() });
const Reason = z.object({ reason: z.string().trim().min(1).max(500) });

export const cashRoutes: FastifyPluginAsyncZod = async (app) => {
  const deps = app.deps;
  const db = deps.db;

  // ── Счёт брони ───────────────────────────────────────────────────────────
  app.get(
    '/bookings/:id/folio',
    {
      schema: { tags: ['Касса'], summary: 'Счёт брони: проживание, начисления, оплаты, остаток', params: PI, response: { 200: FolioDto } },
      config: { permission: 'folio.view' },
    },
    async (req) => svc.folio(deps, ctxOf(req), req.params.id),
  );

  app.post(
    '/bookings/:id/charges',
    {
      schema: {
        tags: ['Касса'],
        summary: 'Начисление на номер: мини-бар, ресторан, прачечная, трансфер, порча',
        params: PI,
        body: z.object({
          kind: ChargeKind,
          description: z.string().trim().max(200).nullable().optional(),
          quantity: z.number().int().min(1).max(999).default(1),
          unitAmount: z.number().int().min(1),
          serviceDate: z.iso.date().optional(),
        }),
        response: { 201: FolioDto },
      },
      config: { permission: 'folio.charge', idempotent: true },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      await svc.addCharge(deps, ctx, req.params.id, req.body);
      return reply.status(201).send(await svc.folio(deps, ctx, req.params.id));
    },
  );

  app.post(
    '/charges/:id/storno',
    {
      schema: { tags: ['Касса'], summary: 'Сторно начисления с причиной', params: PI, body: Reason, response: { 200: z.object({ id: z.uuid() }) } },
      config: { permission: 'folio.storno' },
    },
    async (req) => ({ id: await svc.stornoCharge(deps, ctxOf(req), req.params.id, req.body.reason) }),
  );

  // ── Оплаты ───────────────────────────────────────────────────────────────
  app.post(
    '/payments',
    {
      schema: {
        tags: ['Касса'],
        summary: 'Оплата, возврат или депозит',
        description:
          'Каждая оплата привязана к брони и ложится в открытую кассовую смену; без смены - 409 code=shift.closed. ' +
          'Наличные, карта и QR пробиваются фискальным чеком. Передавайте Idempotency-Key.',
        params: P,
        body: z.object({
          bookingId: z.uuid(),
          kind: PaymentKind.default('payment'),
          method: PaymentMethod,
          amount: z.number().int().min(1),
          payer: z.enum(['guest', 'company']).optional(),
          comment: z.string().trim().max(300).nullable().optional(),
        }),
        response: { 201: PaymentDto, 409: Problem },
      },
      config: { permission: ['payment.accept', 'payment.refund'], idempotent: true },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      const id = await svc.createPayment(deps, ctx, req.body);
      const [dto] = await svc.paymentDtos(db, [eq(payments.id, id)], deps.fiscal.isTest);
      return reply.status(201).send(dto!);
    },
  );

  app.post(
    '/payments/:id/storno',
    {
      schema: {
        tags: ['Касса'],
        summary: 'Сторно оплаты с причиной',
        description: 'В своей смене - старший администратор, после Z-отчёта - только управляющий.',
        params: PI,
        body: Reason,
        response: { 200: PaymentDto },
      },
      config: { permission: ['payment.storno', 'payment.storno.closed'] },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const id = await svc.stornoPayment(deps, ctx, req.params.id, req.body.reason);
      const [dto] = await svc.paymentDtos(db, [eq(payments.id, id)], deps.fiscal.isTest);
      return dto!;
    },
  );

  app.post(
    '/payments/:id/fiscal-retry',
    {
      schema: { tags: ['Касса'], summary: 'Повторить пробитие чека', params: PI, response: { 204: z.undefined() } },
      config: { permission: 'payment.accept' },
    },
    async (req, reply) => {
      await svc.retryFiscal(deps, ctxOf(req), req.params.id);
      return reply.status(204).send();
    },
  );

  app.get(
    '/payments',
    {
      schema: {
        tags: ['Касса'],
        summary: 'Оплаты за период или смену',
        params: P,
        querystring: z.object({
          shiftId: z.uuid().optional(),
          from: z.iso.date().optional(),
          to: z.iso.date().optional(),
          method: z
            .union([PaymentMethod, z.array(PaymentMethod)])
            .optional()
            .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
        }),
        response: { 200: z.array(PaymentDto) },
      },
      config: { permission: 'cash.view' },
    },
    async (req) => svc.listPayments(deps, ctxOf(req), req.query),
  );

  // ── Смена ────────────────────────────────────────────────────────────────
  app.get(
    '/cash',
    {
      schema: {
        tags: ['Касса'],
        summary: 'Касса сейчас: открытая смена, X-отчёт, прошлая смена, отметка прихода',
        params: P,
        response: { 200: CashStateDto },
      },
      config: { permission: 'cash.view' },
    },
    async (req) => svc.cashState(deps, ctxOf(req)),
  );

  app.post(
    '/cash/shifts',
    {
      schema: {
        tags: ['Касса'],
        summary: 'Открыть смену',
        description: 'Без отметки о приходе - 403 code=attendance.required. Открывающий принимает остаток прошлой смены.',
        params: P,
        body: z.object({ openingCash: z.number().int().min(0).optional() }).default({}),
        response: { 201: ShiftDto, 403: Problem, 409: Problem },
      },
      config: { permission: 'cash.shift' },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      const id = await svc.openNewShift(deps, ctx, req.body);
      return reply.status(201).send(await svc.shiftDto(db, id));
    },
  );

  app.get(
    '/cash/shifts',
    {
      schema: { tags: ['Касса'], summary: 'История смен', params: P, querystring: PageQuery, response: { 200: pageSchema(ShiftDto) } },
      config: { permission: 'cash.view' },
    },
    async (req) => svc.listShifts(db, ctxOf(req), req.query),
  );

  app.get(
    '/cash/shifts/:id/report',
    {
      schema: {
        tags: ['Касса'],
        summary: 'X-отчёт открытой смены или Z-отчёт закрытой',
        params: PI,
        response: { 200: z.object({ kind: z.enum(['x', 'z']), shift: ShiftDto, report: CashReportDto }) },
      },
      config: { permission: 'cash.view' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const [shift] = await db.select().from(cashShifts).where(and(eq(cashShifts.id, req.params.id), eq(cashShifts.propertyId, ctx.propertyId)));
      if (!shift) throw notFound('shift.not_found', 'Смена не найдена');
      if (shift.openedBy !== ctx.actor.id && !can(ctx, 'cash.reports')) {
        throw forbidden('shift.not_owner', 'Чужие смены видят старший администратор, управляющий и бухгалтер');
      }
      const report = shift.status === 'closed' && shift.zReport ? shift.zReport : await svc.buildReport(db, ctx, shift);
      return { kind: shift.status === 'closed' ? ('z' as const) : ('x' as const), shift: await svc.shiftDto(db, shift.id), report };
    },
  );

  app.post(
    '/cash/shifts/:id/movements',
    {
      schema: {
        tags: ['Касса'],
        summary: 'Выемка или внесение наличных',
        description: 'Выемка - деньги сданы бухгалтеру или в банк; внесение - размен в кассу. Обязательна причина.',
        params: PI,
        body: z.object({ kind: z.enum(['withdrawal', 'deposit']), amount: z.number().int().min(1), reason: z.string().trim().min(1).max(300) }),
        response: { 201: z.object({ id: z.uuid() }) },
      },
      config: { permission: 'cash.shift', idempotent: true },
    },
    async (req, reply) => {
      const id = await svc.addCashMovement(deps, ctxOf(req), req.params.id, req.body);
      return reply.status(201).send({ id });
    },
  );

  app.post(
    '/cash/shifts/:id/close',
    {
      schema: {
        tags: ['Касса'],
        summary: 'Z-отчёт: закрыть смену',
        description:
          'Администратор пересчитывает наличные и вводит сумму. При расхождении с расчётной - обязательный комментарий (422). ' +
          'После Z-отчёта смена неизменна.',
        params: PI,
        body: z.object({
          countedCash: z.number().int().min(0),
          discrepancyComment: z.string().trim().max(500).nullable().optional(),
          handedOverTo: z.uuid().nullable().optional(),
        }),
        response: { 200: z.object({ kind: z.literal('z'), shift: ShiftDto, report: CashReportDto }), 422: Problem },
      },
      config: { permission: 'cash.shift' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      await svc.closeShift(deps, ctx, req.params.id, req.body);
      const [shift] = await db.select().from(cashShifts).where(eq(cashShifts.id, req.params.id));
      return { kind: 'z' as const, shift: await svc.shiftDto(db, shift!.id), report: shift!.zReport! };
    },
  );
};
