import type { PropertySettings } from '../../db/schema/index.ts';

/** Часовой пояс новой гостиницы: с 2024 года весь Казахстан живёт по UTC+5. */
export const DEFAULT_TIMEZONE = 'Asia/Almaty';
export const DEFAULT_CURRENCY = 'KZT';

/** Тенге в тиынах: суммы в базе - в минимальных единицах валюты. */
const tenge = (v: number) => v * 100;

/**
 * Настройки новой гостиницы. Всё здесь меняет владелец в «Настройках»; цифры -
 * разумный старт для небольшой гостиницы в Казахстане, а не правило.
 */
export const DEFAULT_SETTINGS: PropertySettings = {
  discountLimitPercent: 10,
  refundLimit: tenge(30_000),
  breakfastPrice: tenge(3_000),
  prepaymentHours: 24,
  autoCancelUnpaid: true,
  requireInspectedForCheckIn: true,
  generalCleaningWeekday: 1,
  dailyCleaningDue: '13:00',
  scanRetentionDays: 365,
  specialPriceBases: ['Сотрудник гостиницы', 'Партнёр', 'Решение владельца', 'Постоянный гость', 'Компенсация по жалобе'],
  cancelReasons: ['Гость отменил', 'Изменились планы', 'Гость выбрал другое жильё', 'Не внесена предоплата', 'Ошибка при бронировании'],
  noShowReasons: ['Гость не приехал и не отвечает', 'Задержка рейса', 'Гость сообщил, что не приедет'],
  stornoReasons: ['Ошибка в сумме', 'Ошибка в способе оплаты', 'Проведено дважды', 'Возврат по жалобе'],
};
