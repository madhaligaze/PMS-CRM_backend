import { auditLog, outboxEvents, type AuditChanges } from '../db/schema/index.ts';
import type { DbOrTx } from '../db/client.ts';
import type { PropertyContext } from './context.ts';

type AuditInput = {
  action: string;
  entityType: string;
  entityId: string;
  entityLabel?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /** Явный набор изменений, если before/after не подходят. */
  changes?: AuditChanges;
  reason?: string | null;
};

// Поля, которые меняются при каждом обновлении и в журнале только шумят.
const IGNORED = new Set(['updatedAt', 'updatedBy', 'version', 'hkStatusAt']);

function normalize(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  return v;
}

/** Только изменившиеся поля: [было, стало]. */
export function diff(before: Record<string, unknown> | null | undefined, after: Record<string, unknown> | null | undefined): AuditChanges {
  const out: AuditChanges = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) {
    if (IGNORED.has(key)) continue;
    const a = normalize(before?.[key]);
    const b = normalize(after?.[key]);
    if (JSON.stringify(a) !== JSON.stringify(b)) out[key] = [a ?? null, b ?? null];
  }
  return out;
}

/** Кто и где действует: контекст гостиницы или уровень арендатора (вход, профиль). */
export type AuditScope = Pick<PropertyContext, 'orgId' | 'actor' | 'requestId' | 'ip'> & { propertyId: string | null };

/**
 * Запись в журнал действий. Вызывается в той же транзакции, что и изменение:
 * если изменение откатилось, записи о нём тоже нет.
 */
export async function audit(tx: DbOrTx, ctx: AuditScope, input: AuditInput): Promise<void> {
  const changes = input.changes ?? (input.before !== undefined || input.after !== undefined ? diff(input.before, input.after) : undefined);
  await tx.insert(auditLog).values({
    orgId: ctx.orgId,
    propertyId: ctx.propertyId,
    actorId: ctx.actor.id,
    actorName: ctx.actor.name,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    entityLabel: input.entityLabel ?? null,
    changes: changes && Object.keys(changes).length ? changes : null,
    reason: input.reason ?? null,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });
}

/**
 * Событие для внешнего мира (outbox). Попадает в поток SSE после коммита;
 * дальше на нём же строятся push-уведомления и интеграции.
 */
export async function emit(
  tx: DbOrTx,
  ctx: Pick<PropertyContext, 'propertyId'>,
  topic: string,
  entityId: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await tx.insert(outboxEvents).values({ propertyId: ctx.propertyId, topic, entityId, payload });
}
