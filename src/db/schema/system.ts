import { bigint, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { filePurposeEnum } from './enums.ts';
import { orgs, users } from './org.ts';

export type AuditChanges = Record<string, [unknown, unknown]>;

/**
 * Журнал действий: кто, что, когда, старое и новое значение. Только
 * добавление: UPDATE, DELETE и TRUNCATE запрещены триггером в базе.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: uuid('org_id').notNull(),
    propertyId: uuid('property_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid('actor_id'),
    /** Имя на момент действия: журнал читается и после переименования сотрудника. */
    actorName: text('actor_name').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    /** Человекочитаемая подпись сущности на момент действия: «Бронь 1042». */
    entityLabel: text('entity_label'),
    changes: jsonb('changes').$type<AuditChanges>(),
    reason: text('reason'),
    requestId: text('request_id'),
    ip: text('ip'),
  },
  (t) => [
    index('audit_property_at_idx').on(t.propertyId, t.at),
    index('audit_entity_idx').on(t.entityType, t.entityId),
    index('audit_actor_idx').on(t.actorId, t.at),
  ],
);

/**
 * Исходящие события (outbox). Пишутся в той же транзакции, что и изменение,
 * поэтому событие не теряется и не уходит раньше коммита. Отсюда их берут
 * поток SSE для веба, а позже - push для мобильных и внешние интеграции.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    propertyId: uuid('property_id').notNull(),
    topic: text('topic').notNull(),
    entityId: text('entity_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('outbox_property_idx').on(t.propertyId, t.id)],
);

/** Ответы на запросы с Idempotency-Key: повтор того же запроса получает тот же ответ. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid('user_id').notNull(),
    key: text('key').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    requestHash: text('request_hash').notNull(),
    statusCode: integer('status_code'),
    response: jsonb('response'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

/** Файл в хранилище (локальный диск или S3). Байты идут мимо API-логики по подписанной ссылке. */
export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    propertyId: uuid('property_id'),
    purpose: filePurposeEnum('purpose').notNull(),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    status: text('status', { enum: ['pending', 'ready'] }).notNull().default('pending'),
    uploadedBy: uuid('uploaded_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('files_org_idx').on(t.orgId)],
);
