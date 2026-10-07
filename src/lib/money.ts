/**
 * Деньги - целые числа в минимальных единицах валюты (тиыны для тенге).
 * Никаких float: 0.1 + 0.2 в кассе недопустимо.
 */

export const MINOR_PER_UNIT = 100;

export function sum(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/**
 * Цена после скидки в процентах, округлённая до целой денежной единицы
 * (тенге): тиынов в кассе нет, сдачу ими не дают.
 */
export function applyPercentDiscount(amount: number, percent: number): number {
  const discounted = (amount * (100 - percent)) / 100;
  return Math.round(discounted / MINOR_PER_UNIT) * MINOR_PER_UNIT;
}

export function assertMinor(amount: number): void {
  if (!Number.isSafeInteger(amount)) throw new Error(`Сумма должна быть целым числом минимальных единиц: ${amount}`);
}
