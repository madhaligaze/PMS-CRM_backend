import { and, asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../core/audit.ts';
import { ctxOf } from '../../core/guards.ts';
import { ratePlans, ratePrices, roomTypes } from '../../db/schema/index.ts';
import { diffDays } from '../../lib/dates.ts';
import { badRequest, conflict, notFound } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { quote } from './pricing.ts';

const P = z.object({ propertyId: z.uuid() });
const Weekdays = z.array(z.number().int().min(1).max(7)).min(1).max(7);

export const RatePriceDto = z
  .object({
    id: z.uuid(),
    ratePlanId: z.uuid(),
    roomTypeId: z.uuid(),
    label: z.string(),
    validFrom: z.iso.date(),
    validTo: z.iso.date(),
    weekdays: z.array(z.number().int()),
    amount: z.number().int().describe('Цена за ночь в минимальных единицах валюты'),
    priority: z.number().int(),
  })
  .meta({ id: 'RatePrice' });

export const RatePlanDto = z
  .object({
    id: z.uuid(),
    code: z.string(),
    name: z.string(),
    kind: z.enum(['standard', 'corporate', 'group']),
    includesBreakfast: z.boolean(),
    isActive: z.boolean(),
    sort: z.number().int(),
    prices: z.array(RatePriceDto),
  })
  .meta({ id: 'RatePlan' });

export const NightDto = z
  .object({ date: z.iso.date(), base: z.number().int(), amount: z.number().int() })
  .meta({ id: 'Night' });

export const QuoteDto = z
  .object({
    nights: z.array(NightDto),
    baseTotal: z.number().int(),
    accommodationTotal: z.number().int(),
    discountTotal: z.number().int(),
    mealTotal: z.number().int(),
    total: z.number().int(),
    includesBreakfast: z.boolean(),
  })
  .meta({ id: 'Quote' });

type PriceRow = typeof ratePrices.$inferSelect;
const priceDto = (r: PriceRow) => ({
  id: r.id,
  ratePlanId: r.ratePlanId,
  roomTypeId: r.roomTypeId,
  label: r.label,
  validFrom: r.validFrom,
  validTo: r.validTo,
  weekdays: r.weekdays,
  amount: r.amount,
  priority: r.priority,
});

export const rateRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = app.deps.db;

  app.get(
    '/rate-plans',
    {
      schema: { tags: ['Тарифы'], summary: 'Тарифы с ценами', params: P, response: { 200: z.array(RatePlanDto) } },
      config: { permission: ['booking.view', 'rates.manage'] },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const plans = await db.select().from(ratePlans).where(eq(ratePlans.propertyId, ctx.propertyId)).orderBy(asc(ratePlans.sort));
      const prices = await db
        .select()
        .from(ratePrices)
        .where(eq(ratePrices.propertyId, ctx.propertyId))
        .orderBy(asc(ratePrices.validFrom), asc(ratePrices.priority));
      return plans.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        kind: p.kind,
        includesBreakfast: p.includesBreakfast,
        isActive: p.isActive,
        sort: p.sort,
        prices: prices.filter((r) => r.ratePlanId === p.id).map(priceDto),
      }));
    },
  );

  app.post(
    '/rate-plans',
    {
      schema: {
        tags: ['Тарифы'],
        summary: 'Новый тариф',
        params: P,
        body: z.object({
          code: z.string().min(1).max(16),
          name: z.string().min(1).max(80),
          kind: z.enum(['standard', 'corporate', 'group']),
          includesBreakfast: z.boolean().default(false),
          sort: z.number().int().default(0),
        }),
        response: { 201: RatePlanDto },
      },
      config: { permission: 'rates.manage' },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      const row = await db.transaction(async (tx) => {
        const [dup] = await tx
          .select({ id: ratePlans.id })
          .from(ratePlans)
          .where(and(eq(ratePlans.propertyId, ctx.propertyId), eq(ratePlans.code, req.body.code)));
        if (dup) throw conflict('rate_plan.code_taken', `Код тарифа ${req.body.code} уже занят`);
        const [created] = await tx.insert(ratePlans).values({ id: newId(), propertyId: ctx.propertyId, ...req.body }).returning();
        await audit(tx, ctx, { action: 'rate_plan.create', entityType: 'rate_plan', entityId: created!.id, entityLabel: created!.name, after: { ...req.body } });
        return created!;
      });
      return reply.status(201).send({ ...row, prices: [] });
    },
  );

  app.patch(
    '/rate-plans/:id',
    {
      schema: {
        tags: ['Тарифы'],
        summary: 'Изменить тариф',
        params: P.extend({ id: z.uuid() }),
        body: z.object({
          name: z.string().min(1).max(80).optional(),
          includesBreakfast: z.boolean().optional(),
          isActive: z.boolean().optional(),
          sort: z.number().int().optional(),
        }),
        response: { 200: RatePlanDto },
      },
      config: { permission: 'rates.manage' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      return db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(ratePlans)
          .where(and(eq(ratePlans.id, req.params.id), eq(ratePlans.propertyId, ctx.propertyId)))
          .for('update');
        if (!before) throw notFound('rate_plan.not_found', 'Тариф не найден');
        const [after] = await tx
          .update(ratePlans)
          .set({ ...req.body, version: before.version + 1 })
          .where(eq(ratePlans.id, before.id))
          .returning();
        await audit(tx, ctx, { action: 'rate_plan.update', entityType: 'rate_plan', entityId: before.id, entityLabel: after!.name, before, after: after! });
        const prices = await tx.select().from(ratePrices).where(eq(ratePrices.ratePlanId, before.id));
        return { ...after!, prices: prices.map(priceDto) };
      });
    },
  );

  const PriceBody = z.object({
    roomTypeId: z.uuid(),
    label: z.string().min(1).max(80),
    validFrom: z.iso.date(),
    validTo: z.iso.date(),
    weekdays: Weekdays.default([1, 2, 3, 4, 5, 6, 7]),
    amount: z.number().int().min(0),
    priority: z.number().int().min(0).max(100).default(0),
  });

  app.post(
    '/rate-plans/:id/prices',
    {
      schema: {
        tags: ['Тарифы'],
        summary: 'Цена тарифа на период',
        description: 'Сезон перекрывает базовую цену большим приоритетом, выходные - ещё большим.',
        params: P.extend({ id: z.uuid() }),
        body: PriceBody,
        response: { 201: RatePriceDto },
      },
      config: { permission: 'rates.manage' },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      if (req.body.validTo < req.body.validFrom) throw badRequest('rate.period_invalid', 'Конец периода раньше начала');
      const row = await db.transaction(async (tx) => {
        const [plan] = await tx
          .select()
          .from(ratePlans)
          .where(and(eq(ratePlans.id, req.params.id), eq(ratePlans.propertyId, ctx.propertyId)));
        if (!plan) throw notFound('rate_plan.not_found', 'Тариф не найден');
        const [type] = await tx
          .select()
          .from(roomTypes)
          .where(and(eq(roomTypes.id, req.body.roomTypeId), eq(roomTypes.propertyId, ctx.propertyId)));
        if (!type) throw notFound('room_type.not_found', 'Тип номера не найден');
        const [created] = await tx
          .insert(ratePrices)
          .values({ id: newId(), propertyId: ctx.propertyId, ratePlanId: plan.id, ...req.body })
          .returning();
        await audit(tx, ctx, {
          action: 'rate_price.create',
          entityType: 'rate_plan',
          entityId: plan.id,
          entityLabel: `${plan.name} · ${type.name}`,
          after: priceDto(created!),
        });
        return created!;
      });
      return reply.status(201).send(priceDto(row));
    },
  );

  app.patch(
    '/rate-prices/:id',
    {
      schema: {
        tags: ['Тарифы'],
        summary: 'Изменить цену тарифа',
        params: P.extend({ id: z.uuid() }),
        body: PriceBody.partial(),
        response: { 200: RatePriceDto },
      },
      config: { permission: 'rates.manage' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      return db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(ratePrices)
          .where(and(eq(ratePrices.id, req.params.id), eq(ratePrices.propertyId, ctx.propertyId)))
          .for('update');
        if (!before) throw notFound('rate_price.not_found', 'Цена не найдена');
        const next = { ...before, ...req.body };
        if (next.validTo < next.validFrom) throw badRequest('rate.period_invalid', 'Конец периода раньше начала');
        const [after] = await tx.update(ratePrices).set(req.body).where(eq(ratePrices.id, before.id)).returning();
        await audit(tx, ctx, { action: 'rate_price.update', entityType: 'rate_plan', entityId: before.ratePlanId, entityLabel: after!.label, before: priceDto(before), after: priceDto(after!) });
        return priceDto(after!);
      });
    },
  );

  app.post(
    '/quotes',
    {
      schema: {
        tags: ['Тарифы'],
        summary: 'Расчёт цены проживания',
        description: 'Цены по ночам, скидка, завтрак. Ничего не сохраняет: для формы брони.',
        params: P,
        body: z.object({
          roomTypeId: z.uuid(),
          ratePlanId: z.uuid(),
          arrival: z.iso.date(),
          departure: z.iso.date(),
          adults: z.number().int().min(1).max(12).default(1),
          meal: z.enum(['none', 'breakfast']).default('none'),
          priceMode: z.enum(['rate', 'discount', 'special']).default('rate'),
          discountPercent: z.number().int().min(0).max(100).nullable().optional(),
          specialNightly: z.number().int().min(0).nullable().optional(),
        }),
        response: { 200: QuoteDto },
      },
      config: { permission: ['booking.view', 'booking.create'] },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const nights = diffDays(req.body.arrival, req.body.departure);
      if (nights < 1) throw badRequest('booking.dates_invalid', 'Выезд должен быть позже заезда');
      if (nights > 90) throw badRequest('booking.too_long', 'Проживание длиннее 90 ночей оформляется частями');
      return quote(db, ctx, req.body);
    },
  );
};
