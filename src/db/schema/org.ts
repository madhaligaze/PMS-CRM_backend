import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Rights } from '../../lib/access.ts';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/** Арендатор: компания-владелец. База гостей общая для всех её гостиниц. */
export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

export type PropertySettings = {
  /** Скидка, которую администраторы дают без управляющего, в процентах. */
  discountLimitPercent: number;
  /** Возврат без согласования управляющего, в тиынах. */
  refundLimit: number;
  /** Завтрак за взрослого в сутки, в тиынах (если тариф его не включает). */
  breakfastPrice: number;
  /** Срок предоплаты предварительной брони, в часах от создания. */
  prepaymentHours: number;
  autoCancelUnpaid: boolean;
  requireInspectedForCheckIn: boolean;
  /** День генеральной уборки: 1 - понедельник, 7 - воскресенье. */
  generalCleaningWeekday: number;
  /** Время, к которому должна быть закончена ежедневная уборка, ЧЧ:ММ. */
  dailyCleaningDue: string;
  /** Срок хранения сканов документов, в днях. */
  scanRetentionDays: number;
  specialPriceBases: string[];
  cancelReasons: string[];
  noShowReasons: string[];
  stornoReasons: string[];
};

/** Гостиница. Всё операционное (номера, брони, касса) привязано к ней. */
export const properties = pgTable('properties', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id),
  name: text('name').notNull(),
  /** Часовой пояс гостиницы: «сегодня», ночь и смена считаются по нему. */
  timezone: text('timezone').notNull(),
  /** ISO 4217. Суммы во всей системе - целые в минимальных единицах этой валюты. */
  currency: text('currency').notNull(),
  checkInTime: time('check_in_time').notNull().default('14:00'),
  checkOutTime: time('check_out_time').notNull().default('12:00'),
  address: text('address'),
  phone: text('phone'),
  settings: jsonb('settings').$type<PropertySettings>().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: integer('version').notNull().default(1),
});

/** Сотрудник. Входит под своим логином; права - от роли, а не от человека. */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    login: text('login').notNull(),
    fullName: text('full_name').notNull(),
    phone: text('phone'),
    passwordHash: text('password_hash').notNull(),
    /** Пароль выдан управляющим: при первом входе сотрудник задаёт свой. */
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    /** PIN для отметки прихода на общем планшете. */
    pinHash: text('pin_hash'),
    totpSecret: text('totp_secret'),
    totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true }),
    /** Вход только со вторым фактором: владелец, администраторы и те, кому поставил управляющий. */
    totpRequired: boolean('totp_required').notNull().default(false),
    /** Заблокирован: войти нельзя, пока не разблокируют. */
    isActive: boolean('is_active').notNull().default(true),
    /** Уволен: в списках сотрудников нет, имя остаётся в истории и журнале. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: integer('version').notNull().default(1),
  },
  (t) => [uniqueIndex('users_org_login_uq').on(t.orgId, sql`lower(${t.login})`)],
);

/**
 * Должность: подпись и права по умолчанию для нового человека на ней. Список
 * свой у каждой организации и растёт прямо из поля при найме.
 */
export const positions = pgTable(
  'positions',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    name: text('name').notNull(),
    rights: jsonb('rights').$type<Rights>().notNull().default({ sections: {}, powers: [] }),
    requireTotp: boolean('require_totp').notNull().default(false),
    sort: integer('sort').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('positions_org_name_uq').on(t.orgId, sql`lower(${t.name})`).where(sql`${t.archivedAt} is null`)],
);

/**
 * Доступ сотрудника к гостинице: владелец и администратор видят всё, у
 * сотрудника - права по разделам (`lib/access.ts`).
 */
export const memberships = pgTable(
  'memberships',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    access: text('access', { enum: ['owner', 'admin', 'staff'] }).notNull().default('staff'),
    positionId: uuid('position_id').references(() => positions.id),
    rights: jsonb('rights').$type<Rights>().notNull().default({ sections: {}, powers: [] }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.propertyId] }),
    check('memberships_access_chk', sql`${t.access} in ('owner', 'admin', 'staff')`),
    // Владелец у гостиницы один.
    uniqueIndex('memberships_one_owner_uq').on(t.propertyId).where(sql`${t.access} = 'owner'`),
  ],
);

/** Сессия = refresh-токен. Хранится только хеш; ротация с обнаружением повторного использования. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    clientType: text('client_type').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('sessions_token_hash_uq').on(t.tokenHash), index('sessions_family_idx').on(t.familyId)],
);

/** Сквозные человекочитаемые номера (бронь 1042, оплата 318, смена 57) в пределах гостиницы. */
export const counters = pgTable(
  'counters',
  {
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    name: text('name').notNull(),
    value: bigint('value', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.propertyId, t.name] })],
);
