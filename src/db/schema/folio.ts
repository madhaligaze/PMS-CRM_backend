import { sql } from 'drizzle-orm';
import { bigint, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { bookingGroups, bookings } from './bookings.ts';
import { companies } from './crm.ts';
import {
  chargeKindEnum,
  fiscalStatusEnum,
  paymentKindEnum,
  paymentMethodEnum,
  paymentTypeEnum,
  shiftStatusEnum,
} from './enums.ts';
import { properties, users } from './org.ts';

/**
 * Начисление на счёт брони сверх проживания: мини-бар, ресторан, прачечная,
 * трансфер, порча имущества. Не удаляется: отмена - это сторно, новая строка
 * с обратной суммой и ссылкой на исходную.
 */
export const folioItems = pgTable(
  'folio_items',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    kind: chargeKindEnum('kind').notNull(),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull().default(1),
    unitAmount: bigint('unit_amount', { mode: 'number' }).notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    serviceDate: date('service_date', { mode: 'string' }).notNull(),
    stornoOf: uuid('storno_of'),
    stornoReason: text('storno_reason'),
    reversedBy: uuid('reversed_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id),
  },
  (t) => [index('folio_items_booking_idx').on(t.bookingId)],
);

export const cashRegisters = pgTable('cash_registers', {
  id: uuid('id').primaryKey(),
  propertyId: uuid('property_id')
    .notNull()
    .references(() => properties.id),
  name: text('name').notNull(),
  /** Заводской номер ККМ, когда касса будет подключена. */
  fiscalDeviceId: text('fiscal_device_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Выемка и внесение наличных: деньги уходят из кассы бухгалтеру или в кассу
 * кладут размен. Без них остаток наличных только растёт от смены к смене.
 */
export const cashMovements = pgTable(
  'cash_movements',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    shiftId: uuid('shift_id')
      .notNull()
      .references(() => cashShifts.id),
    kind: text('kind', { enum: ['withdrawal', 'deposit'] }).notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
  },
  (t) => [index('cash_movements_shift_idx').on(t.shiftId)],
);

export type ZReportLine = { key: string; label: string; amount: number; count: number };
export type ZReport = {
  shiftNumber: number;
  openedAt: string;
  closedAt: string;
  openedBy: string;
  closedBy: string;
  currency: string;
  byMethod: ZReportLine[];
  byPaymentType: ZReportLine[];
  refunds: ZReportLine;
  stornos: ZReportLine;
  deposits: ZReportLine;
  withdrawals: ZReportLine;
  cashDeposits: ZReportLine;
  openingCash: number;
  cashIn: number;
  cashOut: number;
  expectedCash: number;
  countedCash: number;
  discrepancy: number;
  discrepancyComment: string | null;
  specialPrices: { bookingNumber: number; guest: string; basis: string; approvedBy: string; discount: number }[];
};

/**
 * Кассовая смена. Без открытой смены принять оплату нельзя. После Z-отчёта
 * смена неизменна: триггер в базе не даст её поправить.
 */
export const cashShifts = pgTable(
  'cash_shifts',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    registerId: uuid('register_id')
      .notNull()
      .references(() => cashRegisters.id),
    number: integer('number').notNull(),
    status: shiftStatusEnum('status').notNull().default('open'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    openedBy: uuid('opened_by')
      .notNull()
      .references(() => users.id),
    openingCash: bigint('opening_cash', { mode: 'number' }).notNull().default(0),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: uuid('closed_by').references(() => users.id),
    expectedCash: bigint('expected_cash', { mode: 'number' }),
    countedCash: bigint('counted_cash', { mode: 'number' }),
    discrepancy: bigint('discrepancy', { mode: 'number' }),
    discrepancyComment: text('discrepancy_comment'),
    zReport: jsonb('z_report').$type<ZReport>(),
    handedOverTo: uuid('handed_over_to').references(() => users.id),
    acceptedBy: uuid('accepted_by').references(() => users.id),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('cash_shifts_number_uq').on(t.propertyId, t.number),
    uniqueIndex('cash_shifts_one_open_uq')
      .on(t.registerId)
      .where(sql`${t.status} = 'open'`),
  ],
);

/**
 * Оплата, возврат, депозит. Один кассовый документ на каждую оплату. Не
 * удаляется: отмена - сторно в текущей смене со ссылкой на исходную.
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    number: integer('number').notNull(),
    shiftId: uuid('shift_id')
      .notNull()
      .references(() => cashShifts.id),
    bookingId: uuid('booking_id').references(() => bookings.id),
    groupId: uuid('group_id').references(() => bookingGroups.id),
    kind: paymentKindEnum('kind').notNull(),
    method: paymentMethodEnum('method').notNull(),
    /** Тип оплаты брони на момент платежа: строка в X/Z-отчёте. */
    paymentType: paymentTypeEnum('payment_type').notNull(),
    /** Всегда положительная; знак задаёт kind и сторно. */
    amount: bigint('amount', { mode: 'number' }).notNull(),
    payer: text('payer', { enum: ['guest', 'company'] }).notNull().default('guest'),
    companyId: uuid('company_id').references(() => companies.id),
    comment: text('comment'),
    fiscalStatus: fiscalStatusEnum('fiscal_status').notNull().default('not_required'),
    fiscalNumber: text('fiscal_number'),
    fiscalSign: text('fiscal_sign'),
    fiscalAt: timestamp('fiscal_at', { withTimezone: true }),
    stornoOf: uuid('storno_of'),
    stornoReason: text('storno_reason'),
    reversedBy: uuid('reversed_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    uniqueIndex('payments_number_uq').on(t.propertyId, t.number),
    index('payments_shift_idx').on(t.shiftId),
    index('payments_booking_idx').on(t.bookingId),
    index('payments_created_idx').on(t.propertyId, t.createdAt),
  ],
);
