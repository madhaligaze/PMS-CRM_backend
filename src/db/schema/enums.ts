import { pgEnum } from 'drizzle-orm/pg-core';

// Перечисления живут в базе, чтобы мусор не попал в данные даже в обход API.
// Значения только добавляются (ALTER TYPE ... ADD VALUE): старые мобильные
// клиенты продолжают их понимать.

export const bookingStatusEnum = pgEnum('booking_status', [
  'tentative',
  'confirmed',
  'checked_in',
  'checked_out',
  'cancelled',
  'no_show',
]);

export const bookingSourceEnum = pgEnum('booking_source', [
  'phone',
  'walk_in',
  'website',
  'whatsapp',
  'instagram',
  'booking_com',
  'ota_other',
  'email',
  'other',
]);

/** Тип оплаты брони из ТЗ: определяет строку в X- и Z-отчётах. */
export const paymentTypeEnum = pgEnum('payment_type', ['cash', 'cashless', 'special']);

export const priceModeEnum = pgEnum('price_mode', ['rate', 'discount', 'special']);

export const mealPlanEnum = pgEnum('meal_plan', ['none', 'breakfast']);

export const hkStatusEnum = pgEnum('hk_status', ['dirty', 'cleaning', 'clean', 'inspected', 'repair']);

export const hkTaskKindEnum = pgEnum('hk_task_kind', ['departure', 'stayover', 'request', 'general']);

export const hkTaskStatusEnum = pgEnum('hk_task_status', [
  'open',
  'in_progress',
  'done',
  'inspected',
  'skipped',
  'cancelled',
]);

export const maintenanceStatusEnum = pgEnum('maintenance_status', ['open', 'in_progress', 'done', 'cancelled']);

export const urgencyEnum = pgEnum('urgency', ['low', 'normal', 'high', 'critical']);

export const paymentMethodEnum = pgEnum('payment_method', ['cash', 'card', 'qr', 'transfer', 'invoice']);

export const paymentKindEnum = pgEnum('payment_kind', ['payment', 'refund', 'deposit', 'deposit_return']);

export const fiscalStatusEnum = pgEnum('fiscal_status', ['not_required', 'pending', 'printed', 'failed']);

export const shiftStatusEnum = pgEnum('shift_status', ['open', 'closed']);

export const attendanceKindEnum = pgEnum('attendance_kind', ['in', 'out']);

export const attendanceMethodEnum = pgEnum('attendance_method', ['pin', 'self', 'manual']);

export const docTypeEnum = pgEnum('doc_type', [
  'passport',
  'id_card',
  'foreign_passport',
  'residence_permit',
  'other',
]);

export const chargeKindEnum = pgEnum('charge_kind', [
  'minibar',
  'restaurant',
  'laundry',
  'transfer',
  'damage',
  'breakfast',
  'service',
  'other',
]);

export const filePurposeEnum = pgEnum('file_purpose', ['guest_document', 'maintenance_photo', 'task_photo']);

export const consentMethodEnum = pgEnum('consent_method', ['paper', 'tablet']);
