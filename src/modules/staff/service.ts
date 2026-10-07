import { randomInt } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { DbOrTx as Conn } from '../../db/client.ts';
import { positions } from '../../db/schema/index.ts';
import { cleanRights, DEFAULT_POSITIONS, type Rights } from '../../lib/access.ts';
import { badRequest } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';

/** Должности новой организации: список, который владелец увидит при первом найме. */
export async function createDefaultPositions(db: Conn, orgId: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const [i, p] of DEFAULT_POSITIONS.entries()) {
    const id = newId();
    ids.set(p.name, id);
    await db.insert(positions).values({ id, orgId, name: p.name, rights: p.rights, requireTotp: p.requireTotp, sort: i + 1 });
  }
  return ids;
}

export type PositionRow = typeof positions.$inferSelect;

/**
 * Должность по id или по названию из поля. Новое название заводит должность
 * сразу: так список растёт из найма, без отдельного экрана. Права новой
 * должности - те, что выставили человеку, которого на неё нанимают.
 */
export async function resolvePosition(
  db: Conn,
  orgId: string,
  input: { positionId?: string | null | undefined; positionName?: string | null | undefined },
  rightsForNew: Rights,
): Promise<{ row: PositionRow | null; created: boolean }> {
  if (input.positionId) {
    const [row] = await db
      .select()
      .from(positions)
      .where(and(eq(positions.id, input.positionId), eq(positions.orgId, orgId), isNull(positions.archivedAt)));
    if (!row) throw badRequest('position.not_found', 'Такой должности нет');
    return { row, created: false };
  }
  const name = input.positionName?.trim().replace(/\s+/g, ' ');
  if (!name) return { row: null, created: false };
  if (name.length > 80) throw badRequest('position.name_long', 'Название должности - до 80 знаков');
  const [found] = await db
    .select()
    .from(positions)
    .where(and(eq(positions.orgId, orgId), isNull(positions.archivedAt), sql`lower(${positions.name}) = lower(${name})`));
  if (found) return { row: found, created: false };
  const [{ max }] = (await db
    .select({ max: sql<number>`coalesce(max(${positions.sort}), 0)` })
    .from(positions)
    .where(eq(positions.orgId, orgId))) as [{ max: number }];
  const [row] = await db
    .insert(positions)
    .values({ id: newId(), orgId, name: capitalize(name), rights: cleanRights(rightsForNew), sort: Number(max) + 1 })
    .returning();
  return { row: row!, created: true };
}

export async function listPositions(db: Conn, orgId: string): Promise<PositionRow[]> {
  return db
    .select()
    .from(positions)
    .where(and(eq(positions.orgId, orgId), isNull(positions.archivedAt)))
    .orderBy(asc(positions.sort), asc(positions.name));
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Временный пароль: его диктуют или пишут на бумажке, поэтому без похожих
 * знаков (0/O, 1/l/I). При первом входе сотрудник задаёт свой.
 */
export function temporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 10; i++) out += alphabet[randomInt(alphabet.length)];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** PIN для планшета прихода: четыре цифры, не «1111» и не «1234». */
export function randomPin(): string {
  for (;;) {
    const pin = String(randomInt(10_000)).padStart(4, '0');
    if (/^(\d)\1{3}$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) continue;
    return pin;
  }
}
