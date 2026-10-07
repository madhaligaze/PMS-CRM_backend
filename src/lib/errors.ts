/**
 * Ошибка предметной области. Уходит клиенту как application/problem+json
 * (RFC 9457): стабильный code для программ и title/detail на русском для людей.
 * Мобильные клиенты ветвятся по code, тексты показывают как есть.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string | undefined;
  readonly extra: Record<string, unknown> | undefined;

  constructor(status: number, code: string, title: string, detail?: string, extra?: Record<string, unknown>) {
    super(title);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.extra = extra;
  }
}

export const badRequest = (code: string, title: string, detail?: string, extra?: Record<string, unknown>) =>
  new AppError(400, code, title, detail, extra);

export const unauthorized = (code: string, title: string, detail?: string) => new AppError(401, code, title, detail);

export const forbidden = (code: string, title: string, detail?: string, extra?: Record<string, unknown>) =>
  new AppError(403, code, title, detail, extra);

export const notFound = (code: string, title: string) => new AppError(404, code, title);

export const conflict = (code: string, title: string, detail?: string, extra?: Record<string, unknown>) =>
  new AppError(409, code, title, detail, extra);

export const preconditionFailed = (title: string, detail?: string, extra?: Record<string, unknown>) =>
  new AppError(412, 'version.conflict', title, detail, extra);

export const unprocessable = (code: string, title: string, detail?: string, extra?: Record<string, unknown>) =>
  new AppError(422, code, title, detail, extra);

/** Код ошибки Postgres из исключения драйвера (postgres.js или обёртки drizzle). */
export function pgCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 4; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export function pgConstraint(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 4; depth++) {
    const name = (cur as { constraint_name?: unknown; constraint?: unknown }).constraint_name ??
      (cur as { constraint?: unknown }).constraint;
    if (typeof name === 'string') return name;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export function pgMessage(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 4; depth++) {
    if (pgCode(cur) && cur instanceof Error && !(cur as { cause?: unknown }).cause) return cur.message;
    const cause = (cur as { cause?: unknown }).cause;
    if (!cause && cur instanceof Error) return cur.message;
    cur = cause;
  }
  return undefined;
}
