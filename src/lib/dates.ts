/**
 * Даты гостиницы. Ночи, заезды и выезды - это даты без времени ('YYYY-MM-DD')
 * в часовом поясе гостиницы; моменты (оплата, отметка) - UTC. Смешивать их
 * нельзя: «сегодня» в Алматы и в UTC расходятся на 5 часов.
 */

const DAY_MS = 86_400_000;

/**
 * Операционные сутки начинаются в 06:00 по времени гостиницы. Гость, который
 * пришёл в 02:00, живёт ночь «вчерашней» даты: она и попадает в бронь.
 */
export const BUSINESS_DAY_START_HOUR = 6;

export function isPlainDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function toUtcMs(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/** Сколько суток от a до b (b - a). */
export function diffDays(a: string, b: string): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

/** Ночи проживания [arrival, departure): даты, за которые берётся оплата. */
export function eachNight(arrival: string, departure: string): string[] {
  const out: string[] = [];
  for (let d = arrival; d < departure; d = addDays(d, 1)) out.push(d);
  return out;
}

/** День недели ISO: 1 - понедельник, 7 - воскресенье. */
export function isoWeekday(date: string): number {
  const wd = new Date(toUtcMs(date)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

export function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

type ZonedParts = { date: string; hour: number; minute: number };

function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** Календарная дата в часовом поясе гостиницы. */
export function localDate(instant: Date, timeZone: string): string {
  return zonedParts(instant, timeZone).date;
}

/** Операционная дата гостиницы с учётом начала суток в 06:00. */
export function businessDate(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return p.hour < BUSINESS_DAY_START_HOUR ? addDays(p.date, -1) : p.date;
}

/** Смещение пояса относительно UTC в минутах для данного момента. */
function offsetMinutes(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = toUtcMs(p.date) + p.hour * 3_600_000 + p.minute * 60_000;
  const floored = Math.floor(instant.getTime() / 60_000) * 60_000;
  return Math.round((asUtc - floored) / 60_000);
}

/** Момент UTC для местной даты и времени гостиницы: '2026-10-07' + '14:00' в Asia/Almaty. */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [h = 0, m = 0] = time.split(':').map(Number);
  const guess = new Date(toUtcMs(date) + h * 3_600_000 + m * 60_000);
  const offset = offsetMinutes(guess, timeZone);
  const result = new Date(guess.getTime() - offset * 60_000);
  // Второй проход на случай перехода на летнее время между guess и result.
  const offset2 = offsetMinutes(result, timeZone);
  return offset2 === offset ? result : new Date(guess.getTime() - offset2 * 60_000);
}

/** Первый и последний день месяца 'YYYY-MM'. */
export function monthRange(month: string): { from: string; to: string } {
  const from = `${month}-01`;
  const next = new Date(toUtcMs(from));
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { from, to: addDays(fromUtcMs(next.getTime()), -1) };
}
