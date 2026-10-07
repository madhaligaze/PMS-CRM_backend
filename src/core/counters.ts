import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';

/**
 * Следующий человекочитаемый номер (бронь, оплата, смена, заявка) в пределах
 * гостиницы. UPSERT берёт блокировку строки счётчика до конца транзакции:
 * номера идут без дублей; при откате транзакции номер не расходуется.
 */
export async function nextNumber(tx: DbOrTx, propertyId: string, name: string, start = 1): Promise<number> {
  const rows = await tx.execute<{ value: string | number }>(sql`
    insert into counters (property_id, name, value)
    values (${propertyId}, ${name}, ${start})
    on conflict (property_id, name) do update set value = counters.value + 1
    returning value
  `);
  return Number(rows[0]!.value);
}
