import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { memberships, properties, sessions, users } from '../db/schema/index.ts';
import { cleanRights, effectiveRights, permissionsFor, type Access, type Permission } from '../lib/access.ts';
import { forbidden, unauthorized } from '../lib/errors.ts';
import type { PropertyContext } from './context.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Проверка Bearer-токена и живой сессии. Токен отозванной сессии не работает сразу. */
export async function authenticate(app: FastifyInstance, req: FastifyRequest): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw unauthorized('auth.required', 'Нужен вход в систему');
  }
  const claims = await app.deps.tokens.verifyAccess(header.slice(7).trim());
  const [row] = await app.deps.db
    .select({
      revokedAt: sessions.revokedAt,
      expiresAt: sessions.expiresAt,
      isActive: users.isActive,
      archivedAt: users.archivedAt,
      fullName: users.fullName,
      orgId: users.orgId,
      totpEnabledAt: users.totpEnabledAt,
      totpRequired: users.totpRequired,
      mustChangePassword: users.mustChangePassword,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, claims.sid), eq(sessions.userId, claims.sub)))
    .limit(1);
  if (!row || row.revokedAt || row.expiresAt.getTime() < Date.now()) {
    throw unauthorized('auth.session_ended', 'Сессия завершена, войдите снова');
  }
  if (!row.isActive || row.archivedAt) throw unauthorized('auth.user_disabled', 'Учётная запись отключена');
  req.auth = {
    userId: claims.sub,
    orgId: row.orgId,
    sessionId: claims.sid,
    userName: row.fullName,
    totpEnabled: row.totpEnabledAt != null,
    totpRequired: row.totpRequired,
    mustChangePassword: row.mustChangePassword,
  };
}

export async function loadPropertyContext(app: FastifyInstance, req: FastifyRequest, propertyId: string): Promise<PropertyContext> {
  const auth = req.auth;
  if (!auth) throw unauthorized('auth.required', 'Нужен вход в систему');
  if (!UUID_RE.test(propertyId)) throw forbidden('property.forbidden', 'Нет доступа к этой гостинице');
  const [row] = await app.deps.db
    .select({ access: memberships.access, rights: memberships.rights, property: properties })
    .from(memberships)
    .innerJoin(properties, eq(properties.id, memberships.propertyId))
    .where(and(eq(memberships.userId, auth.userId), eq(memberships.propertyId, propertyId)))
    .limit(1);
  if (!row || row.property.orgId !== auth.orgId) {
    throw forbidden('property.forbidden', 'Нет доступа к этой гостинице');
  }
  if (auth.mustChangePassword) {
    throw forbidden('auth.password_change_required', 'Сначала задайте свой пароль', 'Пароль выдан управляющим и действует только для первого входа.');
  }
  if (app.deps.config.REQUIRE_TOTP_FOR_PRIVILEGED && auth.totpRequired && !auth.totpEnabled) {
    throw forbidden('auth.totp_setup_required', 'Включите двухфакторный вход', 'Для вашей учётной записи вход без второго фактора запрещён. Настройте код в профиле.');
  }
  const access = row.access as Access;
  const rights = effectiveRights(access, cleanRights(row.rights));
  return {
    orgId: auth.orgId,
    propertyId,
    property: {
      name: row.property.name,
      timezone: row.property.timezone,
      currency: row.property.currency,
      checkInTime: row.property.checkInTime.slice(0, 5),
      checkOutTime: row.property.checkOutTime.slice(0, 5),
      settings: row.property.settings,
    },
    actor: { id: auth.userId, name: auth.userName },
    access,
    rights,
    permissions: permissionsFor(access, rights),
    requestId: String(req.id),
    ip: req.ip ?? null,
  };
}

function checkRoutePermission(req: FastifyRequest, ctx: PropertyContext): void {
  const needed = req.routeOptions.config.permission;
  if (!needed) return;
  const list: Permission[] = Array.isArray(needed) ? needed : [needed];
  if (!list.some((p) => ctx.permissions.has(p))) {
    throw forbidden('permission.denied', 'Недостаточно прав для этого действия', undefined, { permission: list });
  }
}

/** Хук области «/properties/:propertyId/…»: вход, доступ к гостинице, право маршрута. */
export function propertyScopeHook(app: FastifyInstance) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    await authenticate(app, req);
    const propertyId = (req.params as { propertyId?: string }).propertyId ?? '';
    req.ctx = await loadPropertyContext(app, req, propertyId);
    checkRoutePermission(req, req.ctx);
  };
}

/** Хук области, где нужен только вход (профиль, список гостиниц). */
export function authScopeHook(app: FastifyInstance) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    await authenticate(app, req);
  };
}

export function ctxOf(req: FastifyRequest): PropertyContext {
  if (!req.ctx) throw unauthorized('auth.required', 'Нужен вход в систему');
  return req.ctx;
}

export function authOf(req: FastifyRequest) {
  if (!req.auth) throw unauthorized('auth.required', 'Нужен вход в систему');
  return req.auth;
}
