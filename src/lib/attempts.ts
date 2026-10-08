/**
 * Подбор пароля и PIN: неудачи считаются по учётной записи, а не по адресу.
 * В гостинице все компьютеры, телефоны и планшет выходят в интернет через
 * один адрес: лимит по адресу в пересменку закрыл бы вход всем сразу, а
 * подбирающего со своего адреса не остановил бы.
 *
 * Первые FREE неудач за окно - без задержки (опечатки). Дальше учётная запись
 * на паузе: 30 секунд, и каждая новая неудача удваивает паузу до 15 минут.
 * Удачный вход обнуляет счёт. Счёт - в памяти процесса: при нескольких
 * экземплярах API защита слабее, но не исчезает.
 */
const WINDOW_MS = 15 * 60_000;
const FREE = 5;
const BASE_PAUSE_MS = 30_000;
const MAX_PAUSE_MS = 15 * 60_000;
const MAX_KEYS = 20_000;

type Entry = { count: number; first: number; until: number };
const failures = new Map<string, Entry>();

function prune(now: number) {
  if (failures.size < MAX_KEYS) return;
  for (const [k, e] of failures) if (now - e.first > WINDOW_MS && e.until < now) failures.delete(k);
  // Если и после чистки тесно - отбрасываем самые старые: память важнее точности.
  while (failures.size >= MAX_KEYS) failures.delete(failures.keys().next().value!);
}

/** Сколько миллисекунд учётная запись ещё на паузе; 0 - можно пробовать. */
export function pauseLeft(key: string, now = Date.now()): number {
  const e = failures.get(key);
  if (!e) return 0;
  if (now - e.first > WINDOW_MS && e.until <= now) {
    failures.delete(key);
    return 0;
  }
  return Math.max(0, e.until - now);
}

export function recordFailure(key: string, now = Date.now()): void {
  prune(now);
  const prev = failures.get(key);
  const e = prev && now - prev.first <= WINDOW_MS ? prev : { count: 0, first: now, until: 0 };
  e.count += 1;
  if (e.count >= FREE) e.until = now + Math.min(MAX_PAUSE_MS, BASE_PAUSE_MS * 2 ** (e.count - FREE));
  failures.set(key, e);
}

export function recordSuccess(key: string): void {
  failures.delete(key);
}

/** Для тестов: начать с чистого счёта. */
export function resetAttempts(): void {
  failures.clear();
}
