import { z } from 'zod';

export const DocType = z.enum(['passport', 'id_card', 'foreign_passport', 'residence_permit', 'other']).meta({ id: 'DocType' });

export const GuestPreferencesDto = z
  .object({ roomType: z.string().optional(), allergies: z.string().optional(), notes: z.string().optional() })
  .meta({ id: 'GuestPreferences' });

export const GuestStatsDto = z
  .object({
    stays: z.number().int(),
    nights: z.number().int(),
    spent: z.number().int().describe('Проживание и начисления по завершённым и текущим броням'),
    lastStay: z.iso.date().nullable(),
    cancellations: z.number().int(),
    noShows: z.number().int(),
  })
  .meta({ id: 'GuestStats' });

export const GuestDto = z
  .object({
    id: z.uuid(),
    lastName: z.string(),
    firstName: z.string(),
    middleName: z.string().nullable(),
    fullName: z.string(),
    birthDate: z.iso.date().nullable(),
    gender: z.enum(['m', 'f']).nullable(),
    citizenship: z.string().nullable(),
    docType: DocType.nullable(),
    docNumber: z.string().nullable(),
    docIssuedBy: z.string().nullable(),
    docIssuedOn: z.iso.date().nullable(),
    docExpiresOn: z.iso.date().nullable(),
    personalNumber: z.string().nullable(),
    address: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    language: z.string().nullable(),
    companyId: z.uuid().nullable(),
    companyName: z.string().nullable(),
    isVip: z.boolean(),
    blacklisted: z.boolean(),
    blacklistReason: z.string().nullable(),
    preferences: GuestPreferencesDto,
    notes: z.string().nullable(),
    marketingConsent: z.boolean(),
    pdConsentAt: z.iso.datetime().nullable(),
    pdConsentMethod: z.enum(['paper', 'tablet']).nullable(),
    mergedInto: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    version: z.number().int(),
    stats: GuestStatsDto,
  })
  .meta({ id: 'Guest' });

export const GuestListItemDto = z
  .object({
    id: z.uuid(),
    fullName: z.string(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    citizenship: z.string().nullable(),
    birthDate: z.iso.date().nullable(),
    docNumber: z.string().nullable(),
    companyName: z.string().nullable(),
    isVip: z.boolean(),
    blacklisted: z.boolean(),
    stays: z.number().int(),
    lastStay: z.iso.date().nullable(),
  })
  .meta({ id: 'GuestListItem' });

/** Поля карточки, которые можно задать при создании и изменении. */
export const GuestInput = z.object({
  lastName: z.string().trim().min(1).max(80),
  firstName: z.string().trim().min(1).max(80),
  middleName: z.string().trim().max(80).nullable().optional(),
  birthDate: z.iso.date().nullable().optional(),
  gender: z.enum(['m', 'f']).nullable().optional(),
  citizenship: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, 'Гражданство - трёхбуквенный код страны, например KAZ')
    .nullable()
    .optional(),
  docType: DocType.nullable().optional(),
  docNumber: z.string().trim().max(40).nullable().optional(),
  docIssuedBy: z.string().trim().max(200).nullable().optional(),
  docIssuedOn: z.iso.date().nullable().optional(),
  docExpiresOn: z.iso.date().nullable().optional(),
  personalNumber: z.string().trim().max(20).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.email().max(200).nullable().optional(),
  language: z.string().trim().max(10).nullable().optional(),
  companyId: z.uuid().nullable().optional(),
  isVip: z.boolean().optional(),
  preferences: GuestPreferencesDto.optional(),
  notes: z.string().max(2000).nullable().optional(),
  marketingConsent: z.boolean().optional(),
});
export type GuestInputT = z.infer<typeof GuestInput>;

export const CompanyDto = z
  .object({
    id: z.uuid(),
    name: z.string(),
    taxId: z.string().nullable(),
    legalAddress: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    contactName: z.string().nullable(),
    notes: z.string().nullable(),
    guests: z.number().int(),
    bookings: z.number().int(),
    version: z.number().int(),
  })
  .meta({ id: 'Company' });

export const CompanyInput = z.object({
  name: z.string().trim().min(1).max(200),
  taxId: z.string().trim().max(20).nullable().optional(),
  legalAddress: z.string().trim().max(300).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.email().max(200).nullable().optional(),
  contactName: z.string().trim().max(120).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const MatchReason = z.enum(['document', 'phone', 'name_birth']);

export const GuestMatchDto = z
  .object({
    guest: GuestListItemDto,
    reasons: z.array(MatchReason),
    strength: z.enum(['strong', 'possible']),
  })
  .meta({ id: 'GuestMatch' });

export const GuestDocumentDto = z
  .object({
    id: z.uuid(),
    kind: z.enum(['passport', 'id_front', 'id_back', 'other']),
    fileId: z.uuid(),
    contentType: z.string(),
    size: z.number().int(),
    uploadedAt: z.iso.datetime(),
    uploadedBy: z.string().nullable(),
    retainUntil: z.iso.date().nullable(),
  })
  .meta({ id: 'GuestDocument' });

export const StayDto = z
  .object({
    bookingId: z.uuid(),
    number: z.number().int(),
    propertyName: z.string(),
    status: z.string(),
    arrival: z.iso.date(),
    departure: z.iso.date(),
    roomNumber: z.string(),
    roomTypeName: z.string(),
    total: z.number().int(),
    rating: z.number().int().nullable(),
    feedback: z.string().nullable(),
    cancelReason: z.string().nullable(),
  })
  .meta({ id: 'Stay' });
