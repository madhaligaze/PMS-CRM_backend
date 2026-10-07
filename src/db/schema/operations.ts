import { date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import {
  attendanceKindEnum,
  attendanceMethodEnum,
  hkTaskKindEnum,
  hkTaskStatusEnum,
  maintenanceStatusEnum,
  urgencyEnum,
} from './enums.ts';
import { roomBlocks, rooms } from './inventory.ts';
import { properties, users } from './org.ts';

export type ChecklistItem = { text: string; done: boolean };

/** Задача хозслужбы: уборка при выезде, ежедневная, по запросу гостя, генеральная. */
export const hkTasks = pgTable(
  'hk_tasks',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id),
    kind: hkTaskKindEnum('kind').notNull(),
    status: hkTaskStatusEnum('status').notNull().default('open'),
    /** Операционная дата гостиницы, к которой относится задача. */
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    assigneeId: uuid('assignee_id').references(() => users.id),
    dueAt: timestamp('due_at', { withTimezone: true }),
    note: text('note'),
    checklist: jsonb('checklist').$type<ChecklistItem[]>().notNull().default([]),
    photoFileIds: uuid('photo_file_ids').array().notNull().default([]),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    inspectedAt: timestamp('inspected_at', { withTimezone: true }),
    inspectedBy: uuid('inspected_by').references(() => users.id),
    skipReason: text('skip_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    index('hk_tasks_date_idx').on(t.propertyId, t.businessDate),
    index('hk_tasks_assignee_idx').on(t.assigneeId, t.status),
    index('hk_tasks_updated_idx').on(t.propertyId, t.updatedAt),
  ],
);

/** Заявка на ремонт. Создать может любой сотрудник; если мешает продаже - номер блокируется. */
export const maintenanceRequests = pgTable(
  'maintenance_requests',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    number: integer('number').notNull(),
    roomId: uuid('room_id').references(() => rooms.id),
    location: text('location'),
    title: text('title').notNull(),
    description: text('description'),
    urgency: urgencyEnum('urgency').notNull().default('normal'),
    status: maintenanceStatusEnum('status').notNull().default('open'),
    blockId: uuid('block_id').references(() => roomBlocks.id),
    photoFileIds: uuid('photo_file_ids').array().notNull().default([]),
    assigneeId: uuid('assignee_id').references(() => users.id),
    takenAt: timestamp('taken_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: uuid('closed_by').references(() => users.id),
    closeComment: text('close_comment'),
    closePhotoFileIds: uuid('close_photo_file_ids').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('maintenance_number_uq').on(t.propertyId, t.number),
    index('maintenance_status_idx').on(t.propertyId, t.status),
    index('maintenance_room_idx').on(t.roomId),
  ],
);

/**
 * Отметка прихода и ухода. Исправление не правит запись, а добавляет новую
 * со ссылкой на исправленную и причиной; старая помечается заменённой.
 */
export const attendanceEvents = pgTable(
  'attendance_events',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    kind: attendanceKindEnum('kind').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    method: attendanceMethodEnum('method').notNull(),
    device: text('device'),
    correctsId: uuid('corrects_id'),
    supersededBy: uuid('superseded_by'),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id),
  },
  (t) => [index('attendance_user_idx').on(t.propertyId, t.userId, t.at)],
);
