import { z } from 'zod';
import { badRequest } from './errors.ts';

/**
 * Курсорная пагинация. Курсор непрозрачен для клиента: base64url от ключа
 * сортировки последней строки. В отличие от offset, новые записи не сдвигают
 * страницы, которые мобильный клиент уже загрузил.
 */

export const PageQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function encodeCursor(value: unknown[]): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor<T extends unknown[]>(cursor: string | undefined): T | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed)) throw new Error('not array');
    return parsed as T;
  } catch {
    throw badRequest('cursor.invalid', 'Неверный курсор страницы');
  }
}

export function pageOf<T>(rows: T[], limit: number, keyOf: (row: T) => unknown[]): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  return { items, nextCursor: encodeCursor(keyOf(items[items.length - 1]!)) };
}

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}
