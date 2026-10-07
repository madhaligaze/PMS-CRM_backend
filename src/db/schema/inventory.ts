import { boolean, date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { hkStatusEnum } from './enums.ts';
import { properties, users } from './org.ts';

export const roomTypes = pgTable(
  'room_types',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    baseOccupancy: integer('base_occupancy').notNull().default(2),
    maxOccupancy: integer('max_occupancy').notNull().default(2),
    sort: integer('sort').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('room_types_code_uq').on(t.propertyId, t.code)],
);

/**
 * Номер. Два независимых статуса из ТЗ: занятость считается из броней на
 * сегодня, а состояние (hk_status) ведёт хозслужба.
 */
export const rooms = pgTable(
  'rooms',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id),
    number: text('number').notNull(),
    floor: integer('floor'),
    note: text('note'),
    sort: integer('sort').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    hkStatus: hkStatusEnum('hk_status').notNull().default('inspected'),
    hkStatusAt: timestamp('hk_status_at', { withTimezone: true }).notNull().defaultNow(),
    hkStatusBy: uuid('hk_status_by').references(() => users.id),
    /** «Не беспокоить»: горничная не заходит, пока флаг стоит. */
    dnd: boolean('dnd').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [uniqueIndex('rooms_number_uq').on(t.propertyId, t.number)],
);

/** Блокировка номера на даты (ремонт, плановое обслуживание). На шахматке - штриховка. */
export const roomBlocks = pgTable(
  'room_blocks',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    /** Не включая: блок [startsOn, endsOn). */
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    reason: text('reason').notNull(),
    maintenanceRequestId: uuid('maintenance_request_id'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedBy: uuid('released_by').references(() => users.id),
  },
  (t) => [index('room_blocks_room_idx').on(t.roomId, t.startsOn)],
);

/**
 * Занятость номера по датам. Таблицу ведут триггеры на bookings и room_blocks,
 * приложение в неё не пишет. На ней висит EXCLUDE-ограничение: двойная бронь
 * одного номера на одни даты невозможна на уровне базы (см. миграцию invariants).
 */
export const roomOccupancy = pgTable(
  'room_occupancy',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    propertyId: uuid('property_id').notNull(),
    roomId: uuid('room_id').notNull(),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    bookingId: uuid('booking_id'),
    blockId: uuid('block_id'),
  },
  (t) => [
    uniqueIndex('room_occupancy_booking_uq').on(t.bookingId),
    uniqueIndex('room_occupancy_block_uq').on(t.blockId),
  ],
);
