import { and, eq, lt } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { idempotencyKeys } from '../db/schema/index.ts';
import { sha256 } from '../lib/crypto.ts';
import { conflict, unprocessable } from '../lib/errors.ts';

/**
 * Idempotency-Key для создания брони, оплаты, начисления. Мобильная сеть
 * обрывается после того, как сервер всё сделал, и клиент повторяет запрос.
 * Повтор с тем же ключом получает сохранённый ответ, а не вторую бронь.
 *
 * Ключ занимается до выполнения обработчика: параллельный дубль получит 409.
 * Ответ 5xx ключ освобождает, чтобы клиент мог повторить.
 */
export function registerIdempotency(app: FastifyInstance): void {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.routeOptions.config.idempotent || !req.auth) return;
    const raw = req.headers['idempotency-key'];
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!key) return;
    if (key.length > 200) throw unprocessable('idempotency.key_invalid', 'Слишком длинный Idempotency-Key');

    const path = req.routeOptions.url ?? req.url;
    const requestHash = sha256(JSON.stringify({ m: req.method, u: req.url, b: req.body ?? null }));
    const userId = req.auth.userId;

    const inserted = await app.deps.db
      .insert(idempotencyKeys)
      .values({ userId, key, method: req.method, path, requestHash })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });

    if (inserted.length) {
      req.idempotency = { userId, key };
      return;
    }

    const [existing] = await app.deps.db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
    if (!existing) return;
    if (existing.requestHash !== requestHash) {
      throw unprocessable('idempotency.mismatch', 'Этот Idempotency-Key уже использован для другого запроса');
    }
    if (existing.statusCode == null) {
      throw conflict('idempotency.in_progress', 'Такой же запрос ещё выполняется');
    }
    reply.header('Idempotent-Replayed', 'true');
    return reply.status(existing.statusCode).send(existing.response);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const idem = req.idempotency;
    if (!idem) return payload;
    req.idempotency = null;
    const where = and(eq(idempotencyKeys.userId, idem.userId), eq(idempotencyKeys.key, idem.key));
    if (reply.statusCode >= 500) {
      await app.deps.db.delete(idempotencyKeys).where(where);
      return payload;
    }
    let body: unknown = null;
    if (typeof payload === 'string' && payload) {
      try {
        body = JSON.parse(payload);
      } catch {
        body = payload;
      }
    }
    await app.deps.db.update(idempotencyKeys).set({ statusCode: reply.statusCode, response: body }).where(where);
    return payload;
  });
}

/** Ключи старше суток больше не нужны: клиенты повторяют запрос в пределах минут. */
export async function purgeIdempotencyKeys(app: FastifyInstance): Promise<void> {
  await app.deps.db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, new Date(Date.now() - 86_400_000)));
}
