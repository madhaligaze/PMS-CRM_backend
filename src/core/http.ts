import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, badRequest, pgCode, pgConstraint, pgMessage } from '../lib/errors.ts';
import type { Permission } from '../lib/access.ts';
import type { PropertyContext } from './context.ts';
import type { Deps } from './deps.ts';

export type AuthInfo = {
  userId: string;
  orgId: string;
  sessionId: string;
  userName: string;
  totpEnabled: boolean;
  /** Управляющий требует второй фактор (владелец, администраторы и кому поставили). */
  totpRequired: boolean;
  /** Временный пароль от управляющего: пока не сменён, работать в гостинице нельзя. */
  mustChangePassword: boolean;
};

declare module 'fastify' {
  interface FastifyInstance {
    deps: Deps;
  }
  interface FastifyRequest {
    auth: AuthInfo | null;
    ctx: PropertyContext | null;
    idempotency: { userId: string; key: string } | null;
  }
  interface FastifyContextConfig {
    /** Право, без которого маршрут отвечает 403. Проверяется до разбора тела. */
    permission?: Permission | Permission[];
    /** Повтор запроса с тем же Idempotency-Key вернёт сохранённый ответ. */
    idempotent?: boolean;
  }
}

/** Общая схема ошибки (RFC 9457). Её же видят мобильные клиенты в OpenAPI. */
export const Problem = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    code: z.string(),
    detail: z.string().optional(),
    requestId: z.string().optional(),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .catchall(z.unknown())
  .meta({ id: 'Problem' });

function send(reply: FastifyReply, req: FastifyRequest, status: number, body: Record<string, unknown>) {
  return reply
    .status(status)
    .type('application/problem+json')
    .send({ type: 'about:blank', status, requestId: String(req.id), ...body });
}

export function errorHandler(err: FastifyError | AppError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof AppError) {
    return send(reply, req, err.status, {
      title: err.message,
      code: err.code,
      ...(err.detail ? { detail: err.detail } : {}),
      ...(err.extra ?? {}),
    });
  }

  if (hasZodFastifySchemaValidationErrors(err)) {
    const errors = err.validation.map((v) => ({
      path: [err.validationContext, ...String(v.instancePath ?? '').split('/').filter(Boolean)].join('.'),
      message: v.message ?? 'Неверное значение',
    }));
    return send(reply, req, 400, { title: 'Запрос не прошёл проверку', code: 'validation', errors });
  }

  if (isResponseSerializationError(err)) {
    req.log.error({ err, issues: err.cause.issues }, 'ответ не соответствует схеме');
    return send(reply, req, 500, { title: 'Внутренняя ошибка сервера', code: 'internal' });
  }

  const code = pgCode(err);
  if (code === '23P01') {
    return send(reply, req, 409, {
      title: 'Номер уже занят на эти даты',
      code: 'room.occupied',
      detail: 'Двойная бронь одного номера на одни даты невозможна.',
    });
  }
  if (code === '23505') {
    return send(reply, req, 409, { title: 'Такая запись уже есть', code: 'conflict.duplicate', constraint: pgConstraint(err) });
  }
  if (code === 'P0001') {
    return send(reply, req, 409, { title: pgMessage(err) ?? 'Действие запрещено правилами учёта', code: 'invariant' });
  }
  if (code === '23514') {
    return send(reply, req, 422, { title: 'Данные нарушают правило учёта', code: 'invalid.data', constraint: pgConstraint(err) });
  }

  const fe = err as FastifyError;
  if (fe.statusCode && fe.statusCode < 500) {
    return send(reply, req, fe.statusCode, { title: fe.message, code: fe.code ?? 'request.invalid' });
  }

  req.log.error({ err }, 'необработанная ошибка');
  return send(reply, req, 500, { title: 'Внутренняя ошибка сервера', code: 'internal' });
}

/** Ожидаемая версия записи из If-Match ("3" или W/"3") или из тела. */
export function expectedVersion(req: FastifyRequest, bodyVersion?: number): number {
  const header = req.headers['if-match'];
  if (typeof header === 'string' && header.trim()) {
    const m = header.match(/^(?:W\/)?"?(\d+)"?$/);
    if (!m) throw badRequest('version.header_invalid', 'Заголовок If-Match должен содержать версию записи');
    return Number(m[1]);
  }
  if (typeof bodyVersion === 'number') return bodyVersion;
  throw new AppError(428, 'version.required', 'Нужна версия записи', 'Передайте If-Match: "<version>" или поле version.');
}

export function setEtag(reply: FastifyReply, version: number): void {
  reply.header('ETag', `"${version}"`);
}

export const Uuid = z.uuid();
export const PlainDate = z.iso.date();
export const IsoDateTime = z.iso.datetime({ offset: true });

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
export const isoReq = (d: Date): string => d.toISOString();
