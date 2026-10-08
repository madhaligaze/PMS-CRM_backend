import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../core/audit.ts';
import type { Deps } from '../../core/deps.ts';
import { authOf, authScopeHook } from '../../core/guards.ts';
import { Problem } from '../../core/http.ts';
import { cashRegisters, memberships, positions, properties } from '../../db/schema/index.ts';
import { allRights } from '../../lib/access.ts';
import { conflict, forbidden } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { DEFAULT_CURRENCY, DEFAULT_SETTINGS, DEFAULT_TIMEZONE } from './defaults.ts';

type Auth = { userId: string; orgId: string; userName: string };

/**
 * Ещё одна гостиница сети. Добавляет её владелец: он же становится её
 * владельцем в системе. Гости и компании у сети общие, номера, тарифы, касса
 * и люди - у каждой гостиницы свои. Правила и причины можно взять из уже
 * работающей гостиницы, чтобы не набирать заново.
 */
export async function createProperty(
  deps: Deps,
  auth: Auth,
  input: { name: string; address?: string | null | undefined; phone?: string | null | undefined; copyFrom?: string | null | undefined },
  meta: { ip: string | null; requestId: string },
): Promise<string> {
  const name = input.name.trim();
  return deps.db.transaction(async (tx) => {
    // Две одинаковые гостиницы одним двойным нажатием не появятся.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`property-create:${auth.orgId}`}))`);
    const owned = await tx
      .select({ id: properties.id, settings: properties.settings, checkInTime: properties.checkInTime, checkOutTime: properties.checkOutTime })
      .from(memberships)
      .innerJoin(properties, eq(properties.id, memberships.propertyId))
      .where(and(eq(memberships.userId, auth.userId), eq(memberships.access, 'owner'), eq(properties.orgId, auth.orgId)));
    if (!owned.length) throw forbidden('property.create_forbidden', 'Новую гостиницу добавляет владелец');
    const source = input.copyFrom ? owned.find((p) => p.id === input.copyFrom) : null;
    if (input.copyFrom && !source) throw forbidden('property.forbidden', 'Нет доступа к этой гостинице');
    const [dup] = await tx
      .select({ id: properties.id })
      .from(properties)
      .where(and(eq(properties.orgId, auth.orgId), sql`lower(${properties.name}) = lower(${name})`));
    if (dup) throw conflict('property.name_taken', `Гостиница «${name}» уже есть`);

    const id = newId();
    await tx.insert(properties).values({
      id,
      orgId: auth.orgId,
      name,
      timezone: DEFAULT_TIMEZONE,
      currency: DEFAULT_CURRENCY,
      settings: source?.settings ?? DEFAULT_SETTINGS,
      ...(source ? { checkInTime: source.checkInTime, checkOutTime: source.checkOutTime } : {}),
      address: input.address?.trim() || null,
      phone: input.phone?.trim() || null,
    });
    await tx.insert(cashRegisters).values({ id: newId(), propertyId: id, name: 'Ресепшен' });
    const [manager] = await tx
      .select({ id: positions.id })
      .from(positions)
      .where(and(eq(positions.orgId, auth.orgId), eq(positions.name, 'Управляющий'), isNull(positions.archivedAt)));
    await tx.insert(memberships).values({ userId: auth.userId, propertyId: id, access: 'owner', positionId: manager?.id ?? null, rights: allRights() });
    await audit(tx, { orgId: auth.orgId, propertyId: id, actor: { id: auth.userId, name: auth.userName }, requestId: meta.requestId, ip: meta.ip }, {
      action: 'property.create',
      entityType: 'property',
      entityId: id,
      entityLabel: name,
      changes: { name: [null, name] },
      reason: source ? 'Правила, лимиты и причины взяты из другой гостиницы сети' : null,
    });
    return id;
  });
}

export const propertyCreateRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', authScopeHook(app));
  app.post(
    '/properties',
    {
      schema: {
        tags: ['Гостиница'],
        summary: 'Добавить гостиницу в сеть',
        description: 'Только владелец. copyFrom - гостиница, из которой взять правила, лимиты и причины. Ответ - id новой гостиницы; её доступ появится в GET /me.',
        body: z.object({
          name: z.string().trim().min(2, 'Название - не короче 2 знаков').max(120),
          address: z.string().trim().max(300).nullable().optional(),
          phone: z.string().trim().max(50).nullable().optional(),
          copyFrom: z.uuid().nullable().optional(),
        }),
        response: { 201: z.object({ id: z.uuid() }), 403: Problem, 409: Problem },
      },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const auth = authOf(req);
      if (auth.mustChangePassword) throw forbidden('auth.password_change_required', 'Сначала задайте свой пароль');
      if (app.deps.config.REQUIRE_TOTP_FOR_PRIVILEGED && auth.totpRequired && !auth.totpEnabled) {
        throw forbidden('auth.totp_setup_required', 'Включите двухфакторный вход', 'Для вашей учётной записи вход без второго фактора запрещён. Настройте код в профиле.');
      }
      const id = await createProperty(app.deps, auth, req.body, { ip: req.ip ?? null, requestId: String(req.id) });
      return reply.status(201).send({ id });
    },
  );
};
