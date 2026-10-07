import { boolean, date, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { consentMethodEnum, docTypeEnum } from './enums.ts';
import { orgs, users } from './org.ts';
import { files } from './system.ts';

/** Компания-клиент: корпоративные гости, заказчики мероприятий, плательщик по счёту. */
export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    name: text('name').notNull(),
    /** БИН компании (ИИН - для ИП). */
    taxId: text('tax_id'),
    legalAddress: text('legal_address'),
    phone: text('phone'),
    email: text('email'),
    contactName: text('contact_name'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [index('companies_org_idx').on(t.orgId)],
);

export type GuestPreferences = {
  roomType?: string;
  allergies?: string;
  notes?: string;
};

/**
 * Карточка гостя - центр CRM. Одна запись на человека: дубли ищутся по
 * документу и телефону, объединяются через mergedInto, а не удаляются.
 */
export const guests = pgTable(
  'guests',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    lastName: text('last_name').notNull(),
    firstName: text('first_name').notNull(),
    middleName: text('middle_name'),
    birthDate: date('birth_date', { mode: 'string' }),
    gender: text('gender', { enum: ['m', 'f'] }),
    /** Гражданство, ISO 3166-1 alpha-3, как в MRZ (KAZ, RUS, UZB). */
    citizenship: text('citizenship'),
    docType: docTypeEnum('doc_type'),
    docNumber: text('doc_number'),
    /** Номер документа без пробелов в верхнем регистре: по нему ищутся дубли. */
    docNumberNorm: text('doc_number_norm'),
    docIssuedBy: text('doc_issued_by'),
    docIssuedOn: date('doc_issued_on', { mode: 'string' }),
    docExpiresOn: date('doc_expires_on', { mode: 'string' }),
    /** Индивидуальный идентификационный номер (ИИН). */
    personalNumber: text('personal_number'),
    address: text('address'),
    phone: text('phone'),
    /** Только цифры: по нему ищутся дубли. */
    phoneNorm: text('phone_norm'),
    email: text('email'),
    language: text('language'),
    companyId: uuid('company_id').references(() => companies.id),
    isVip: boolean('is_vip').notNull().default(false),
    blacklisted: boolean('blacklisted').notNull().default(false),
    blacklistReason: text('blacklist_reason'),
    preferences: jsonb('preferences').$type<GuestPreferences>().notNull().default({}),
    notes: text('notes'),
    marketingConsent: boolean('marketing_consent').notNull().default(false),
    marketingConsentAt: timestamp('marketing_consent_at', { withTimezone: true }),
    pdConsentAt: timestamp('pd_consent_at', { withTimezone: true }),
    pdConsentMethod: consentMethodEnum('pd_consent_method'),
    mergedInto: uuid('merged_into'),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    index('guests_org_doc_idx').on(t.orgId, t.docNumberNorm),
    index('guests_org_phone_idx').on(t.orgId, t.phoneNorm),
    index('guests_org_birth_idx').on(t.orgId, t.birthDate),
  ],
);

/** Скан документа. Видят только ресепшен и управляющий; каждый просмотр пишется в журнал. */
export const guestDocuments = pgTable(
  'guest_documents',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    guestId: uuid('guest_id')
      .notNull()
      .references(() => guests.id),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id),
    kind: text('kind', { enum: ['passport', 'id_front', 'id_back', 'other'] }).notNull(),
    retainUntil: date('retain_until', { mode: 'string' }),
    uploadedBy: uuid('uploaded_by').references(() => users.id),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('guest_documents_guest_idx').on(t.guestId)],
);
