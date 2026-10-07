import { sql } from 'drizzle-orm';
import { bigint, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { companies, guests } from './crm.ts';
import { bookingSourceEnum, bookingStatusEnum, mealPlanEnum, paymentTypeEnum, priceModeEnum } from './enums.ts';
import { roomTypes, rooms } from './inventory.ts';
import { properties, users } from './org.ts';
import { ratePlans } from './rates.ts';

/** Групповая бронь: несколько номеров на одну организацию, единый или раздельные счета. */
export const bookingGroups = pgTable('booking_groups', {
  id: uuid('id').primaryKey(),
  propertyId: uuid('property_id')
    .notNull()
    .references(() => properties.id),
  name: text('name').notNull(),
  companyId: uuid('company_id').references(() => companies.id),
  contactGuestId: uuid('contact_guest_id').references(() => guests.id),
  billing: text('billing', { enum: ['single', 'split'] }).notNull().default('split'),
  comment: text('comment'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => users.id),
  version: integer('version').notNull().default(1),
});

/** Ночь проживания: дата, цена по тарифу и цена после скидки или спеццены. */
export type BookingNight = { date: string; base: number; amount: number };

export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    number: integer('number').notNull(),
    status: bookingStatusEnum('status').notNull(),
    guestId: uuid('guest_id')
      .notNull()
      .references(() => guests.id),
    companyId: uuid('company_id').references(() => companies.id),
    groupId: uuid('group_id').references(() => bookingGroups.id),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id),
    arrival: date('arrival', { mode: 'string' }).notNull(),
    /** Дата выезда, не включается в ночи: проживание [arrival, departure). */
    departure: date('departure', { mode: 'string' }).notNull(),
    adults: integer('adults').notNull().default(1),
    children: integer('children').notNull().default(0),
    ratePlanId: uuid('rate_plan_id')
      .notNull()
      .references(() => ratePlans.id),
    meal: mealPlanEnum('meal').notNull().default('none'),
    source: bookingSourceEnum('source').notNull(),
    paymentType: paymentTypeEnum('payment_type').notNull().default('cash'),
    priceMode: priceModeEnum('price_mode').notNull().default('rate'),
    discountPercent: integer('discount_percent'),
    specialNightly: bigint('special_nightly', { mode: 'number' }),
    /** Причина скидки или основание спеццены. */
    priceReason: text('price_reason'),
    priceApprovedBy: uuid('price_approved_by').references(() => users.id),
    nights: jsonb('nights').$type<BookingNight[]>().notNull(),
    baseTotal: bigint('base_total', { mode: 'number' }).notNull(),
    accommodationTotal: bigint('accommodation_total', { mode: 'number' }).notNull(),
    mealTotal: bigint('meal_total', { mode: 'number' }).notNull().default(0),
    prepaymentAmount: bigint('prepayment_amount', { mode: 'number' }),
    prepaymentDueAt: timestamp('prepayment_due_at', { withTimezone: true }),
    comment: text('comment'),
    externalRef: text('external_ref'),
    cancelReason: text('cancel_reason'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => users.id),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
    checkedInBy: uuid('checked_in_by').references(() => users.id),
    keyIssuedAt: timestamp('key_issued_at', { withTimezone: true }),
    checkedOutAt: timestamp('checked_out_at', { withTimezone: true }),
    checkedOutBy: uuid('checked_out_by').references(() => users.id),
    rating: integer('rating'),
    feedback: text('feedback'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').references(() => users.id),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('bookings_number_uq').on(t.propertyId, t.number),
    index('bookings_dates_idx').on(t.propertyId, t.arrival, t.departure),
    index('bookings_guest_idx').on(t.guestId),
    index('bookings_group_idx').on(t.groupId),
    index('bookings_status_idx').on(t.propertyId, t.status),
    index('bookings_updated_idx').on(t.propertyId, t.updatedAt),
    index('bookings_due_idx')
      .on(t.prepaymentDueAt)
      .where(sql`${t.status} = 'tentative'`),
  ],
);
