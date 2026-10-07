import { and, eq, gte, lte } from 'drizzle-orm';
import type { PropertyContext } from '../../core/context.ts';
import type { DbOrTx } from '../../db/client.ts';
import { ratePlans, ratePrices, type BookingNight } from '../../db/schema/index.ts';
import { eachNight, isoWeekday } from '../../lib/dates.ts';
import { notFound, unprocessable } from '../../lib/errors.ts';
import { applyPercentDiscount, sum } from '../../lib/money.ts';

export type PriceMode = 'rate' | 'discount' | 'special';

export type QuoteInput = {
  roomTypeId: string;
  ratePlanId: string;
  arrival: string;
  departure: string;
  adults: number;
  meal: 'none' | 'breakfast';
  priceMode: PriceMode;
  discountPercent?: number | null;
  specialNightly?: number | null;
  /** Цены ночей, которые надо сохранить (продление: старые ночи по старой цене). */
  keepNights?: BookingNight[];
};

export type Quote = {
  nights: BookingNight[];
  baseTotal: number;
  accommodationTotal: number;
  discountTotal: number;
  mealTotal: number;
  total: number;
  includesBreakfast: boolean;
};

type PriceRow = typeof ratePrices.$inferSelect;

/**
 * Цена ночи: строки тарифа, действующие на дату и день недели; побеждает
 * больший приоритет, при равенстве - более позднее начало периода.
 */
export function pickPrice(rows: PriceRow[], date: string): PriceRow | null {
  const wd = isoWeekday(date);
  let best: PriceRow | null = null;
  for (const r of rows) {
    if (r.validFrom > date || r.validTo < date || !r.weekdays.includes(wd)) continue;
    if (
      !best ||
      r.priority > best.priority ||
      (r.priority === best.priority && r.validFrom > best.validFrom) ||
      (r.priority === best.priority && r.validFrom === best.validFrom && r.createdAt > best.createdAt)
    ) {
      best = r;
    }
  }
  return best;
}

export async function quote(tx: DbOrTx, ctx: PropertyContext, input: QuoteInput): Promise<Quote> {
  const [plan] = await tx
    .select()
    .from(ratePlans)
    .where(and(eq(ratePlans.id, input.ratePlanId), eq(ratePlans.propertyId, ctx.propertyId)))
    .limit(1);
  if (!plan) throw notFound('rate_plan.not_found', 'Тариф не найден');

  const dates = eachNight(input.arrival, input.departure);
  const lastNight = dates[dates.length - 1] ?? input.arrival;
  const rows = await tx
    .select()
    .from(ratePrices)
    .where(
      and(
        eq(ratePrices.ratePlanId, plan.id),
        eq(ratePrices.roomTypeId, input.roomTypeId),
        lte(ratePrices.validFrom, lastNight),
        gte(ratePrices.validTo, input.arrival),
      ),
    );

  const kept = new Map((input.keepNights ?? []).map((n) => [n.date, n]));
  const nights: BookingNight[] = [];
  const missing: string[] = [];
  for (const date of dates) {
    const keep = kept.get(date);
    if (keep) {
      nights.push(keep);
      continue;
    }
    const row = pickPrice(rows, date);
    if (!row) {
      missing.push(date);
      continue;
    }
    const base = row.amount;
    let amount = base;
    if (input.priceMode === 'discount') amount = applyPercentDiscount(base, input.discountPercent ?? 0);
    if (input.priceMode === 'special') amount = input.specialNightly ?? base;
    nights.push({ date, base, amount });
  }
  if (missing.length) {
    throw unprocessable('rate.price_missing', `В тарифе «${plan.name}» нет цены на ${missing.length === 1 ? 'дату' : 'даты'} ${missing.join(', ')}`, undefined, {
      dates: missing,
    });
  }

  const baseTotal = sum(nights.map((n) => n.base));
  const accommodationTotal = sum(nights.map((n) => n.amount));
  const mealTotal =
    input.meal === 'breakfast' && !plan.includesBreakfast
      ? ctx.property.settings.breakfastPrice * input.adults * nights.length
      : 0;
  return {
    nights,
    baseTotal,
    accommodationTotal,
    discountTotal: baseTotal - accommodationTotal,
    mealTotal,
    total: accommodationTotal + mealTotal,
    includesBreakfast: plan.includesBreakfast,
  };
}
