import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';

export type Balance = {
  /** Проживание + питание + начисления (сторно уже вычтены). */
  charges: number;
  /** Оплаты за вычетом возвратов и сторно. Депозит сюда не входит. */
  paid: number;
  /** Залог на руках у гостиницы: внесён и ещё не возвращён. */
  deposit: number;
  /** К оплате: charges - paid. Отрицательное - переплата. */
  due: number;
};

export const ZERO_BALANCE: Balance = { charges: 0, paid: 0, deposit: 0, due: 0 };

/**
 * Сверка счёта из ТЗ: проживание + все начисления - оплаты. Считается из
 * документов каждый раз, а не хранится: расхождению между «остатком» и
 * документами взяться неоткуда.
 */
export async function balances(tx: DbOrTx, bookingIds: string[]): Promise<Map<string, Balance>> {
  const out = new Map<string, Balance>();
  if (!bookingIds.length) return out;
  const ids = sql.join(bookingIds.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = await tx.execute<{ id: string; charges: string; paid: string; deposit: string }>(sql`
    select b.id,
      b.accommodation_total + b.meal_total + coalesce(fi.total, 0) as charges,
      coalesce(p.paid, 0) as paid,
      coalesce(p.deposit, 0) as deposit
    from bookings b
    left join (
      select booking_id, sum(amount) as total from folio_items where booking_id in (${ids}) group by booking_id
    ) fi on fi.booking_id = b.id
    left join (
      select booking_id,
        sum(case when kind in ('payment','refund') then
          (case when kind = 'payment' then amount else -amount end) * (case when storno_of is null then 1 else -1 end)
          else 0 end) as paid,
        sum(case when kind in ('deposit','deposit_return') then
          (case when kind = 'deposit' then amount else -amount end) * (case when storno_of is null then 1 else -1 end)
          else 0 end) as deposit
      from payments where booking_id in (${ids}) group by booking_id
    ) p on p.booking_id = b.id
    where b.id in (${ids})
  `);
  for (const r of rows) {
    const charges = Number(r.charges);
    const paid = Number(r.paid);
    out.set(r.id, { charges, paid, deposit: Number(r.deposit), due: charges - paid });
  }
  return out;
}

export async function balanceOf(tx: DbOrTx, bookingId: string): Promise<Balance> {
  return (await balances(tx, [bookingId])).get(bookingId) ?? ZERO_BALANCE;
}
