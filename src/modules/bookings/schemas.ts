import { z } from 'zod';
import { HkStatus } from '../property/routes.ts';
import { NightDto } from '../rates/routes.ts';
import { GuestInput } from '../guests/schemas.ts';

export const BookingStatus = z
  .enum(['tentative', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show'])
  .meta({ id: 'BookingStatus' });
export const BookingSource = z
  .enum(['phone', 'walk_in', 'website', 'whatsapp', 'instagram', 'booking_com', 'ota_other', 'email', 'other'])
  .meta({ id: 'BookingSource' });
export const PaymentType = z.enum(['cash', 'cashless', 'special']).meta({ id: 'PaymentType' });
export const PriceMode = z.enum(['rate', 'discount', 'special']).meta({ id: 'PriceMode' });
export const MealPlan = z.enum(['none', 'breakfast']).meta({ id: 'MealPlan' });

export const BalanceDto = z
  .object({
    charges: z.number().int(),
    paid: z.number().int(),
    deposit: z.number().int(),
    due: z.number().int().describe('К оплате; отрицательное - переплата'),
  })
  .meta({ id: 'Balance' });

export const BookingDto = z
  .object({
    id: z.uuid(),
    number: z.number().int(),
    status: BookingStatus,
    guest: z.object({
      id: z.uuid(),
      fullName: z.string(),
      phone: z.string().nullable(),
      isVip: z.boolean(),
      blacklisted: z.boolean(),
      blacklistReason: z.string().nullable(),
    }),
    companyId: z.uuid().nullable(),
    companyName: z.string().nullable(),
    groupId: z.uuid().nullable(),
    groupName: z.string().nullable(),
    roomTypeId: z.uuid(),
    roomTypeName: z.string(),
    roomId: z.uuid(),
    roomNumber: z.string(),
    roomHkStatus: HkStatus,
    arrival: z.iso.date(),
    departure: z.iso.date(),
    nightsCount: z.number().int(),
    adults: z.number().int(),
    children: z.number().int(),
    ratePlanId: z.uuid(),
    ratePlanName: z.string(),
    meal: MealPlan,
    source: BookingSource,
    paymentType: PaymentType,
    priceMode: PriceMode,
    discountPercent: z.number().int().nullable(),
    specialNightly: z.number().int().nullable(),
    priceReason: z.string().nullable(),
    priceApprovedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    nights: z.array(NightDto),
    baseTotal: z.number().int(),
    accommodationTotal: z.number().int(),
    mealTotal: z.number().int(),
    discountTotal: z.number().int(),
    prepaymentAmount: z.number().int().nullable(),
    prepaymentDueAt: z.iso.datetime().nullable(),
    comment: z.string().nullable(),
    externalRef: z.string().nullable(),
    cancelReason: z.string().nullable(),
    cancelledAt: z.iso.datetime().nullable(),
    cancelledBy: z.string().nullable(),
    checkedInAt: z.iso.datetime().nullable(),
    keyIssuedAt: z.iso.datetime().nullable(),
    checkedOutAt: z.iso.datetime().nullable(),
    rating: z.number().int().nullable(),
    feedback: z.string().nullable(),
    createdAt: z.iso.datetime(),
    createdBy: z.string().nullable(),
    updatedAt: z.iso.datetime(),
    version: z.number().int(),
    /** null - у сотрудника нет права видеть деньги. */
    balance: BalanceDto.nullable(),
    flags: z.object({
      prepaymentOverdue: z.boolean(),
      arrivalToday: z.boolean(),
      departureToday: z.boolean(),
      roomNotReady: z.boolean(),
    }),
  })
  .meta({ id: 'Booking' });

export const BookingListItemDto = z
  .object({
    id: z.uuid(),
    number: z.number().int(),
    status: BookingStatus,
    guestId: z.uuid(),
    guestName: z.string(),
    isVip: z.boolean(),
    roomId: z.uuid(),
    roomNumber: z.string(),
    roomTypeName: z.string(),
    arrival: z.iso.date(),
    departure: z.iso.date(),
    adults: z.number().int(),
    children: z.number().int(),
    source: BookingSource,
    paymentType: PaymentType,
    total: z.number().int().nullable(),
    due: z.number().int().nullable(),
    roomHkStatus: HkStatus,
    prepaymentOverdue: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'BookingListItem' });

const PriceFields = {
  priceMode: PriceMode.default('rate'),
  discountPercent: z.number().int().min(1).max(100).nullable().optional(),
  specialNightly: z.number().int().min(0).nullable().optional(),
  priceReason: z.string().trim().max(300).nullable().optional(),
  priceApprovedBy: z.uuid().nullable().optional(),
};

export const CreateBookingInput = z.object({
  guestId: z.uuid().optional(),
  guest: GuestInput.optional(),
  companyId: z.uuid().nullable().optional(),
  groupId: z.uuid().nullable().optional(),
  roomId: z.uuid(),
  arrival: z.iso.date(),
  departure: z.iso.date(),
  adults: z.number().int().min(1).max(12).default(1),
  children: z.number().int().min(0).max(12).default(0),
  ratePlanId: z.uuid(),
  meal: MealPlan.default('none'),
  source: BookingSource,
  paymentType: PaymentType.default('cash'),
  ...PriceFields,
  status: z.enum(['tentative', 'confirmed']).default('tentative'),
  prepaymentAmount: z.number().int().min(0).nullable().optional(),
  prepaymentDueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  comment: z.string().trim().max(2000).nullable().optional(),
  externalRef: z.string().trim().max(100).nullable().optional(),
  /** Заселить гостя из чёрного списка всё же можно - с правом и осознанно. */
  overrideBlacklist: z.boolean().default(false),
});
export type CreateBookingInputT = z.infer<typeof CreateBookingInput>;

export const UpdateBookingInput = z.object({
  guestId: z.uuid().optional(),
  companyId: z.uuid().nullable().optional(),
  groupId: z.uuid().nullable().optional(),
  roomId: z.uuid().optional(),
  arrival: z.iso.date().optional(),
  departure: z.iso.date().optional(),
  adults: z.number().int().min(1).max(12).optional(),
  children: z.number().int().min(0).max(12).optional(),
  ratePlanId: z.uuid().optional(),
  meal: MealPlan.optional(),
  source: BookingSource.optional(),
  paymentType: PaymentType.optional(),
  priceMode: PriceMode.optional(),
  discountPercent: PriceFields.discountPercent,
  specialNightly: PriceFields.specialNightly,
  priceReason: PriceFields.priceReason,
  priceApprovedBy: PriceFields.priceApprovedBy,
  prepaymentAmount: z.number().int().min(0).nullable().optional(),
  prepaymentDueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  comment: z.string().trim().max(2000).nullable().optional(),
  externalRef: z.string().trim().max(100).nullable().optional(),
  /**
   * keep - ночи, что остались в брони, сохраняют цену; новые ночи считаются
   * по тарифу. all - пересчитать все ночи (смена тарифа, типа номера, скидки).
   */
  reprice: z.enum(['keep', 'all']).default('keep'),
  /** Переселить гостя в номер, который ещё не проверен хозслужбой. */
  overrideRoomStatus: z.boolean().default(false),
  version: z.number().int().optional(),
});
export type UpdateBookingInputT = z.infer<typeof UpdateBookingInput>;

export const ReadinessDto = z
  .object({
    ready: z.boolean(),
    problems: z.array(z.object({ code: z.string(), message: z.string(), blocking: z.boolean() })),
    balance: BalanceDto.nullable(),
  })
  .meta({ id: 'CheckInReadiness' });

export const TapeChartDto = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    businessDate: z.iso.date(),
    roomTypes: z.array(z.object({ id: z.uuid(), code: z.string(), name: z.string(), sort: z.number().int() })),
    rooms: z.array(
      z.object({
        id: z.uuid(),
        number: z.string(),
        roomTypeId: z.uuid(),
        floor: z.number().int().nullable(),
        hkStatus: HkStatus,
        dnd: z.boolean(),
        isActive: z.boolean(),
      }),
    ),
    bookings: z.array(
      z.object({
        id: z.uuid(),
        number: z.number().int(),
        status: BookingStatus,
        roomId: z.uuid(),
        arrival: z.iso.date(),
        departure: z.iso.date(),
        guestName: z.string(),
        isVip: z.boolean(),
        adults: z.number().int(),
        children: z.number().int(),
        paymentType: PaymentType,
        source: BookingSource,
        groupId: z.uuid().nullable(),
        hasComment: z.boolean(),
        due: z.number().int().nullable(),
        prepaymentOverdue: z.boolean(),
        version: z.number().int(),
      }),
    ),
    blocks: z.array(
      z.object({ id: z.uuid(), roomId: z.uuid(), startsOn: z.iso.date(), endsOn: z.iso.date(), reason: z.string() }),
    ),
    days: z.array(z.object({ date: z.iso.date(), occupied: z.number().int(), available: z.number().int() })),
  })
  .meta({ id: 'TapeChart' });

export const RoomBlockDto = z
  .object({
    id: z.uuid(),
    roomId: z.uuid(),
    roomNumber: z.string(),
    startsOn: z.iso.date(),
    endsOn: z.iso.date(),
    reason: z.string(),
    isActive: z.boolean(),
    maintenanceRequestId: z.uuid().nullable(),
  })
  .meta({ id: 'RoomBlock' });

export const GroupDto = z
  .object({
    id: z.uuid(),
    name: z.string(),
    companyId: z.uuid().nullable(),
    companyName: z.string().nullable(),
    billing: z.enum(['single', 'split']),
    comment: z.string().nullable(),
    bookings: z.array(BookingListItemDto),
    version: z.number().int(),
  })
  .meta({ id: 'BookingGroup' });
