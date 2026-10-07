import { bigint, boolean, date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { roomTypes } from './inventory.ts';
import { properties } from './org.ts';

/** Тарифный план: стандартный, корпоративный, групповой. */
export const ratePlans = pgTable(
  'rate_plans',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['standard', 'corporate', 'group'] }).notNull(),
    includesBreakfast: boolean('includes_breakfast').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    sort: integer('sort').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [uniqueIndex('rate_plans_code_uq').on(t.propertyId, t.code)],
);

/**
 * Цена за ночь для типа номера в тарифе на период и дни недели.
 * Для даты берётся строка с наибольшим приоритетом, при равенстве - с более
 * поздним началом периода. Так сезон перекрывает базовую цену, а выходные - сезон.
 */
export const ratePrices = pgTable(
  'rate_prices',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    ratePlanId: uuid('rate_plan_id')
      .notNull()
      .references(() => ratePlans.id),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id),
    label: text('label').notNull(),
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    /** Включительно. */
    validTo: date('valid_to', { mode: 'string' }).notNull(),
    /** Дни недели ISO: 1 - понедельник ... 7 - воскресенье. */
    weekdays: integer('weekdays').array().notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    priority: integer('priority').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('rate_prices_lookup_idx').on(t.ratePlanId, t.roomTypeId, t.validFrom)],
);
