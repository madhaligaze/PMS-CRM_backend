/**
 * Нормализация для поиска дублей. Храним и исходное значение (как ввели), и
 * нормализованное (по нему ищем): «8 701 123 45 67» и «+7 (701) 123-45-67» -
 * один и тот же телефон.
 */

/** Телефон: только цифры, казахстанские форматы приводятся к виду 7XXXXXXXXXX. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D+/g, '');
  if (!digits) return null;
  // 8 701 123 45 67 - местный формат с восьмёркой.
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  // 701 123 45 67 - без кода страны.
  if (digits.length === 10 && digits.startsWith('7')) digits = `7${digits}`;
  return digits.length >= 7 ? digits : null;
}

/** Номер документа: верхний регистр, без пробелов, дефисов и №. */
export function normalizeDocNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.toUpperCase().replace(/[\s\-№#.]+/g, '');
  return v.length >= 4 ? v : null;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  return v || null;
}

export function trimOrNull(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const v = raw.trim();
  return v ? v : null;
}

/** «Сәрсенбаева Айгерім Нұрланқызы». */
export function fullName(g: { lastName: string; firstName: string; middleName?: string | null }): string {
  return [g.lastName, g.firstName, g.middleName].filter(Boolean).join(' ');
}

/** «Сәрсенбаева А. Н.»: для журнала и узких колонок. */
export function shortName(g: { lastName: string; firstName: string; middleName?: string | null }): string {
  const initials = [g.firstName, g.middleName]
    .filter(Boolean)
    .map((p) => `${p!.charAt(0)}.`)
    .join(' ');
  return initials ? `${g.lastName} ${initials}` : g.lastName;
}
