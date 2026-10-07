/**
 * Разбор машиночитаемой зоны документа (ICAO 9303): паспорт TD3 (2×44),
 * ID-карта TD1 (3×30), TD2 (2×36). Сканеры документов на ресепшене отдают
 * MRZ текстом, как клавиатура; камера с OCR - тоже текстом. Контрольные
 * цифры проверяются: опечатка распознавания не попадёт в карточку молча.
 */

export type MrzFormat = 'TD1' | 'TD2' | 'TD3';

export type MrzResult = {
  format: MrzFormat;
  documentCode: string;
  docType: 'passport' | 'id_card' | 'other';
  issuingState: string;
  documentNumber: string;
  lastName: string;
  firstName: string;
  middleName: string | null;
  nationality: string;
  birthDate: string | null;
  sex: 'm' | 'f' | null;
  expiryDate: string | null;
  personalNumber: string | null;
  checks: {
    documentNumber: boolean;
    birthDate: boolean;
    expiryDate: boolean;
    composite: boolean | null;
  };
  valid: boolean;
};

const WEIGHTS = [7, 3, 1];

function charValue(ch: string): number {
  if (ch === '<') return 0;
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  if (ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0) - 55;
  return -1;
}

export function checkDigit(field: string): number {
  let total = 0;
  for (let i = 0; i < field.length; i++) {
    const v = charValue(field[i]!);
    if (v < 0) return -1;
    total += v * WEIGHTS[i % 3]!;
  }
  return total % 10;
}

function checkOk(field: string, digit: string): boolean {
  // Пустое поле (одни <) с цифрой 0 или < - допустимо.
  if (/^<+$/.test(field)) return digit === '<' || digit === '0';
  return String(checkDigit(field)) === digit;
}

function clean(s: string): string {
  return s.replace(/<+$/g, '').replace(/</g, ' ').trim();
}

function parseDate(yymmdd: string, kind: 'birth' | 'expiry', now = new Date()): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = yymmdd.slice(2, 4);
  const dd = yymmdd.slice(4, 6);
  const currentYY = now.getUTCFullYear() % 100;
  let century: number;
  if (kind === 'birth') century = yy > currentYY ? 1900 : 2000;
  else century = yy >= 70 ? 1900 : 2000;
  const iso = `${century + yy}-${mm}-${dd}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

function parseNames(field: string): { lastName: string; firstName: string; middleName: string | null } {
  const [surnamePart = '', givenPart = ''] = field.split('<<');
  const lastName = clean(surnamePart);
  const given = clean(givenPart.replace(/<{2,}.*/, '')).split(/\s+/).filter(Boolean);
  return {
    lastName,
    firstName: given[0] ?? '',
    middleName: given.length > 1 ? given.slice(1).join(' ') : null,
  };
}

function docTypeOf(code: string): MrzResult['docType'] {
  if (code.startsWith('P')) return 'passport';
  if (code.startsWith('I') || code.startsWith('A') || code.startsWith('C')) return 'id_card';
  return 'other';
}

/** Нормализует ввод: сканеры вставляют пробелы, переводы строк Windows, строчные буквы. */
export function normalizeMrzLines(text: string): string[] {
  return text
    .toUpperCase()
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, '').replace(/[«‹]/g, '<'))
    .filter((l) => l.length >= 28);
}

export function parseMrz(text: string, now = new Date()): MrzResult | null {
  const lines = normalizeMrzLines(text);
  if (lines.length === 2 && lines[0]!.length === 44 && lines[1]!.length === 44) return parseTd3(lines, now);
  if (lines.length === 3 && lines.every((l) => l.length === 30)) return parseTd1(lines, now);
  if (lines.length === 2 && lines[0]!.length === 36 && lines[1]!.length === 36) return parseTd2(lines, now);
  return null;
}

function parseTd3([l1, l2]: string[], now: Date): MrzResult {
  const a = l1!;
  const b = l2!;
  const docNumberField = b.slice(0, 9);
  const birth = b.slice(13, 19);
  const expiry = b.slice(21, 27);
  const personal = b.slice(28, 42);
  const composite = b.slice(0, 10) + b.slice(13, 20) + b.slice(21, 43);
  const checks = {
    documentNumber: checkOk(docNumberField, b[9]!),
    birthDate: checkOk(birth, b[19]!),
    expiryDate: checkOk(expiry, b[27]!),
    composite: checkOk(composite, b[43]!),
  };
  const sex = b[20];
  return {
    format: 'TD3',
    documentCode: clean(a.slice(0, 2)),
    docType: 'passport',
    issuingState: clean(a.slice(2, 5)),
    documentNumber: clean(docNumberField),
    ...parseNames(a.slice(5)),
    nationality: clean(b.slice(10, 13)),
    birthDate: parseDate(birth, 'birth', now),
    sex: sex === 'M' ? 'm' : sex === 'F' ? 'f' : null,
    expiryDate: parseDate(expiry, 'expiry', now),
    personalNumber: clean(personal) || null,
    checks,
    valid: checks.documentNumber && checks.birthDate && checks.expiryDate && checks.composite,
  };
}

function parseTd1([l1, l2, l3]: string[], now: Date): MrzResult {
  const a = l1!;
  const b = l2!;
  const c = l3!;
  let docNumber = a.slice(5, 14);
  let docCheck = a[14]!;
  const optional1 = a.slice(15, 30);
  // Длинный номер документа: вместо контрольной цифры <, продолжение - в опциональных данных.
  if (docCheck === '<') {
    const rest = optional1.replace(/<.*$/, '');
    docNumber = docNumber + rest.slice(0, -1);
    docCheck = rest.slice(-1);
  }
  const birth = b.slice(0, 6);
  const expiry = b.slice(8, 14);
  const composite = a.slice(5, 30) + b.slice(0, 7) + b.slice(8, 15) + b.slice(18, 29);
  const checks = {
    documentNumber: checkOk(docNumber, docCheck),
    birthDate: checkOk(birth, b[6]!),
    expiryDate: checkOk(expiry, b[14]!),
    composite: checkOk(composite, b[29]!),
  };
  const sex = b[7];
  // ИИН (12 цифр) в удостоверении личности РК лежит в опциональных полях MRZ.
  const optional = [clean(optional1), clean(b.slice(18, 29))].find((v) => /^\d{12}$/.test(v)) ?? null;
  const code = clean(a.slice(0, 2));
  return {
    format: 'TD1',
    documentCode: code,
    docType: docTypeOf(code),
    issuingState: clean(a.slice(2, 5)),
    documentNumber: clean(docNumber),
    ...parseNames(c),
    nationality: clean(b.slice(15, 18)),
    birthDate: parseDate(birth, 'birth', now),
    sex: sex === 'M' ? 'm' : sex === 'F' ? 'f' : null,
    expiryDate: parseDate(expiry, 'expiry', now),
    personalNumber: optional,
    checks,
    valid: checks.documentNumber && checks.birthDate && checks.expiryDate && checks.composite,
  };
}

function parseTd2([l1, l2]: string[], now: Date): MrzResult {
  const a = l1!;
  const b = l2!;
  const docNumberField = b.slice(0, 9);
  const birth = b.slice(13, 19);
  const expiry = b.slice(21, 27);
  const composite = b.slice(0, 10) + b.slice(13, 20) + b.slice(21, 35);
  const checks = {
    documentNumber: checkOk(docNumberField, b[9]!),
    birthDate: checkOk(birth, b[19]!),
    expiryDate: checkOk(expiry, b[27]!),
    composite: checkOk(composite, b[35]!),
  };
  const sex = b[20];
  const code = clean(a.slice(0, 2));
  return {
    format: 'TD2',
    documentCode: code,
    docType: docTypeOf(code),
    issuingState: clean(a.slice(2, 5)),
    documentNumber: clean(docNumberField),
    ...parseNames(a.slice(5)),
    nationality: clean(b.slice(10, 13)),
    birthDate: parseDate(birth, 'birth', now),
    sex: sex === 'M' ? 'm' : sex === 'F' ? 'f' : null,
    expiryDate: parseDate(expiry, 'expiry', now),
    personalNumber: clean(b.slice(28, 35)) || null,
    checks,
    valid: checks.documentNumber && checks.birthDate && checks.expiryDate && checks.composite,
  };
}
