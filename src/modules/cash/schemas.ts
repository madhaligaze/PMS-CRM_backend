import { z } from 'zod';
import { BalanceDto, PaymentType } from '../bookings/schemas.ts';

export const PaymentMethod = z.enum(['cash', 'card', 'qr', 'transfer', 'invoice']).meta({ id: 'PaymentMethod' });
export const PaymentKind = z.enum(['payment', 'refund', 'deposit', 'deposit_return']).meta({ id: 'PaymentKind' });
export const ChargeKind = z
  .enum(['minibar', 'restaurant', 'laundry', 'transfer', 'damage', 'breakfast', 'service', 'other'])
  .meta({ id: 'ChargeKind' });

export const PaymentDto = z
  .object({
    id: z.uuid(),
    number: z.number().int(),
    shiftId: z.uuid(),
    shiftNumber: z.number().int(),
    bookingId: z.uuid().nullable(),
    bookingNumber: z.number().int().nullable(),
    guestName: z.string().nullable(),
    kind: PaymentKind,
    method: PaymentMethod,
    paymentType: PaymentType,
    amount: z.number().int(),
    /** Со знаком для кассы: приход +, расход -, сторно - наоборот. */
    signedAmount: z.number().int(),
    payer: z.enum(['guest', 'company']),
    companyName: z.string().nullable(),
    comment: z.string().nullable(),
    fiscalStatus: z.enum(['not_required', 'pending', 'printed', 'failed']),
    fiscalNumber: z.string().nullable(),
    fiscalTest: z.boolean(),
    stornoOf: z.uuid().nullable(),
    stornoReason: z.string().nullable(),
    reversedBy: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    createdBy: z.string(),
  })
  .meta({ id: 'Payment' });

export const ChargeDto = z
  .object({
    id: z.uuid(),
    kind: ChargeKind,
    description: z.string(),
    quantity: z.number().int(),
    unitAmount: z.number().int(),
    amount: z.number().int(),
    serviceDate: z.iso.date(),
    stornoOf: z.uuid().nullable(),
    stornoReason: z.string().nullable(),
    reversedBy: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    createdBy: z.string().nullable(),
  })
  .meta({ id: 'Charge' });

export const FolioDto = z
  .object({
    bookingId: z.uuid(),
    bookingNumber: z.number().int(),
    status: z.string(),
    guestName: z.string(),
    paymentType: PaymentType,
    accommodation: z.object({
      nights: z.number().int(),
      baseTotal: z.number().int(),
      discountTotal: z.number().int(),
      amount: z.number().int(),
      priceMode: z.enum(['rate', 'discount', 'special']),
      priceReason: z.string().nullable(),
    }),
    meal: z.object({ amount: z.number().int() }),
    charges: z.array(ChargeDto),
    payments: z.array(PaymentDto),
    balance: BalanceDto,
    prepaymentAmount: z.number().int().nullable(),
  })
  .meta({ id: 'Folio' });

export const ReportLineDto = z
  .object({ key: z.string(), label: z.string(), amount: z.number().int(), count: z.number().int() })
  .meta({ id: 'ReportLine' });

export const CashReportDto = z
  .object({
    shiftNumber: z.number().int(),
    openedAt: z.string(),
    closedAt: z.string(),
    openedBy: z.string(),
    closedBy: z.string(),
    currency: z.string(),
    byMethod: z.array(ReportLineDto),
    byPaymentType: z.array(ReportLineDto),
    refunds: ReportLineDto,
    stornos: ReportLineDto,
    deposits: ReportLineDto,
    withdrawals: ReportLineDto,
    cashDeposits: ReportLineDto,
    openingCash: z.number().int(),
    cashIn: z.number().int(),
    cashOut: z.number().int(),
    expectedCash: z.number().int(),
    countedCash: z.number().int(),
    discrepancy: z.number().int(),
    discrepancyComment: z.string().nullable(),
    specialPrices: z.array(
      z.object({ bookingNumber: z.number().int(), guest: z.string(), basis: z.string(), approvedBy: z.string(), discount: z.number().int() }),
    ),
  })
  .meta({ id: 'CashReport' });

export const ShiftDto = z
  .object({
    id: z.uuid(),
    number: z.number().int(),
    status: z.enum(['open', 'closed']),
    registerName: z.string(),
    openedAt: z.iso.datetime(),
    openedBy: z.object({ id: z.uuid(), name: z.string() }),
    openingCash: z.number().int(),
    closedAt: z.iso.datetime().nullable(),
    closedBy: z.string().nullable(),
    expectedCash: z.number().int().nullable(),
    countedCash: z.number().int().nullable(),
    discrepancy: z.number().int().nullable(),
    discrepancyComment: z.string().nullable(),
    handedOverTo: z.string().nullable(),
    acceptedBy: z.string().nullable(),
    acceptedAt: z.iso.datetime().nullable(),
    paymentsCount: z.number().int(),
    version: z.number().int(),
  })
  .meta({ id: 'Shift' });

export const CashStateDto = z
  .object({
    shift: ShiftDto.nullable(),
    report: CashReportDto.nullable().describe('X-отчёт открытой смены'),
    previous: ShiftDto.nullable().describe('Последняя закрытая смена: её принимает тот, кто открывает следующую'),
    clockedIn: z.boolean().describe('Отмечен ли приход: без него открыть смену нельзя'),
    fiscalDriver: z.string(),
    fiscalTest: z.boolean(),
  })
  .meta({ id: 'CashState' });
