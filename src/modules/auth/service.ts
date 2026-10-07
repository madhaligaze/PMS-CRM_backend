import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Deps } from '../../core/deps.ts';
import { audit, type AuditScope } from '../../core/audit.ts';
import { cashRegisters, memberships, orgs, positions, properties, sessions, users } from '../../db/schema/index.ts';
import { ACCESS_LABELS, allRights, cleanRights, effectiveRights, permissionsFor, type Access } from '../../lib/access.ts';
import { hashSecret, randomToken, sha256, verifySecret } from '../../lib/crypto.ts';
import { badRequest, conflict, unauthorized } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../../lib/totp.ts';
import { DEFAULT_CURRENCY, DEFAULT_SETTINGS, DEFAULT_TIMEZONE } from '../property/defaults.ts';
import { createDefaultPositions } from '../staff/service.ts';

// Хеш-пустышка: при неизвестном логине проверка идёт столько же, сколько при
// известном, и по времени ответа нельзя перебрать логины.
let dummyHash: string | null = null;
async function dummyVerify(password: string) {
  dummyHash ??= await hashSecret('timing-equalizer');
  await verifySecret(password, dummyHash);
}

export type ClientType = 'web' | 'mobile' | 'kiosk';

type SessionMeta = { clientType: ClientType; userAgent: string | null; ip: string | null };

export type IssuedTokens = {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  userId: string;
};

async function issue(deps: Deps, user: { id: string; orgId: string }, familyId: string, meta: SessionMeta): Promise<IssuedTokens> {
  const refreshToken = randomToken(32);
  const sessionId = newId();
  const expiresAt = new Date(Date.now() + deps.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  await deps.db.insert(sessions).values({
    id: sessionId,
    userId: user.id,
    familyId,
    tokenHash: sha256(refreshToken),
    clientType: meta.clientType,
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
    ip: meta.ip,
    expiresAt,
  });
  const access = await deps.tokens.signAccess({ sub: user.id, org: user.orgId, sid: sessionId });
  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt.toISOString(),
    refreshToken,
    refreshTokenExpiresAt: expiresAt.toISOString(),
    userId: user.id,
  };
}

export async function login(
  deps: Deps,
  input: { login: string; password: string; totpCode?: string | undefined },
  meta: SessionMeta & { requestId: string },
): Promise<IssuedTokens> {
  const found = await deps.db
    .select()
    .from(users)
    .where(sql`lower(${users.login}) = lower(${input.login.trim()})`)
    .limit(2);
  if (found.length > 1) throw badRequest('auth.ambiguous_login', 'Логин не уникален: укажите организацию');
  const user = found[0];
  if (!user) {
    await dummyVerify(input.password);
    throw unauthorized('auth.invalid_credentials', 'Неверный логин или пароль');
  }
  const ok = await verifySecret(input.password, user.passwordHash);
  if (!ok) throw unauthorized('auth.invalid_credentials', 'Неверный логин или пароль');
  if (user.archivedAt) throw unauthorized('auth.user_disabled', 'Учётная запись закрыта', 'Если это ошибка, обратитесь к управляющему.');
  if (!user.isActive) throw unauthorized('auth.user_disabled', 'Вход заблокирован', 'Разблокировать может управляющий.');

  if (user.totpEnabledAt && user.totpSecret) {
    if (!input.totpCode) throw unauthorized('auth.totp_required', 'Введите код из приложения');
    if (!verifyTotp(user.totpSecret, input.totpCode)) throw unauthorized('auth.totp_invalid', 'Код не подошёл');
  }

  const tokens = await issue(deps, user, newId(), meta);
  await deps.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await audit(deps.db, scopeOf(user, meta), {
    action: 'auth.login',
    entityType: 'user',
    entityId: user.id,
    entityLabel: user.fullName,
    changes: { client: [null, meta.clientType] },
  });
  return tokens;
}

function scopeOf(user: { id: string; orgId: string; fullName: string }, meta: { ip: string | null; requestId?: string }): AuditScope {
  return {
    orgId: user.orgId,
    propertyId: null,
    actor: { id: user.id, name: user.fullName },
    requestId: meta.requestId ?? null,
    ip: meta.ip,
  };
}

/** Секунды, в которые повтор старого refresh-токена считается гонкой вкладок, а не кражей. */
const REUSE_GRACE_MS = 15_000;

/**
 * Ротация refresh-токена. Каждый токен одноразовый. Повтор уже использованного
 * токена означает утечку: вся цепочка сессий отзывается, и вор, и владелец
 * входят заново.
 */
export async function refresh(deps: Deps, refreshToken: string, meta: SessionMeta): Promise<IssuedTokens> {
  const [session] = await deps.db.select().from(sessions).where(eq(sessions.tokenHash, sha256(refreshToken))).limit(1);
  if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) {
    throw unauthorized('auth.session_ended', 'Сессия завершена, войдите снова');
  }
  if (session.rotatedAt) {
    if (Date.now() - session.rotatedAt.getTime() < REUSE_GRACE_MS) {
      throw conflict('auth.refresh_retry', 'Токен уже обновлён в другой вкладке, повторите запрос');
    }
    await deps.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.familyId, session.familyId), isNull(sessions.revokedAt)));
    throw unauthorized('auth.refresh_reused', 'Сессия отозвана из соображений безопасности, войдите снова');
  }
  const claimed = await deps.db
    .update(sessions)
    .set({ rotatedAt: new Date() })
    .where(and(eq(sessions.id, session.id), isNull(sessions.rotatedAt)))
    .returning({ id: sessions.id });
  if (!claimed.length) throw conflict('auth.refresh_retry', 'Токен уже обновлён в другой вкладке, повторите запрос');

  const [user] = await deps.db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  if (!user || !user.isActive || user.archivedAt) throw unauthorized('auth.user_disabled', 'Учётная запись отключена');
  return issue(deps, user, session.familyId, meta);
}

/** Нужна ли регистрация: гостиница ещё не заведена ни одна. */
export async function setupNeeded(deps: Deps): Promise<boolean> {
  const [org] = await deps.db.select({ id: orgs.id }).from(orgs).limit(1);
  return !org;
}

/**
 * Регистрация: первая гостиница и её владелец. Работает один раз - пока в
 * базе нет ни одной организации; дальше людей заводит владелец в «Сотрудниках».
 */
export async function setup(
  deps: Deps,
  input: { hotelName: string; fullName: string; login: string; password: string; phone?: string | null | undefined },
  meta: SessionMeta & { requestId: string },
): Promise<IssuedTokens> {
  const user = await deps.db.transaction(async (tx) => {
    // Две регистрации разом не создадут двух владельцев.
    await tx.execute(sql`select pg_advisory_xact_lock(727001)`);
    const [existing] = await tx.select({ id: orgs.id }).from(orgs).limit(1);
    if (existing) throw conflict('setup.done', 'Гостиница уже зарегистрирована', 'Войдите под своим логином.');
    const orgId = newId();
    const propertyId = newId();
    const userId = newId();
    const name = input.hotelName.trim();
    await tx.insert(orgs).values({ id: orgId, name });
    await tx.insert(properties).values({ id: propertyId, orgId, name, timezone: DEFAULT_TIMEZONE, currency: DEFAULT_CURRENCY, settings: DEFAULT_SETTINGS });
    await tx.insert(cashRegisters).values({ id: newId(), propertyId, name: 'Ресепшен' });
    const positionIds = await createDefaultPositions(tx, orgId);
    const row = {
      id: userId,
      orgId,
      login: input.login.trim(),
      fullName: input.fullName.trim(),
      phone: input.phone?.trim() || null,
      passwordHash: await hashSecret(input.password),
      totpRequired: true,
      passwordChangedAt: new Date(),
    };
    await tx.insert(users).values(row);
    await tx.insert(memberships).values({ userId, propertyId, access: 'owner', positionId: positionIds.get('Управляющий') ?? null, rights: allRights() });
    await audit(tx, { orgId, propertyId, actor: { id: userId, name: row.fullName }, requestId: meta.requestId, ip: meta.ip }, {
      action: 'setup.done',
      entityType: 'property',
      entityId: propertyId,
      entityLabel: name,
      changes: { owner: [null, row.fullName] },
    });
    return row;
  });
  return issue(deps, user, newId(), meta);
}

export async function logout(deps: Deps, by: { refreshToken?: string | null; sessionId?: string | null }): Promise<void> {
  const now = new Date();
  if (by.refreshToken) {
    const [s] = await deps.db.select().from(sessions).where(eq(sessions.tokenHash, sha256(by.refreshToken))).limit(1);
    if (s) {
      await deps.db
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.familyId, s.familyId), isNull(sessions.revokedAt)));
    }
  }
  if (by.sessionId) {
    const [s] = await deps.db.select().from(sessions).where(eq(sessions.id, by.sessionId)).limit(1);
    if (s) {
      await deps.db
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.familyId, s.familyId), isNull(sessions.revokedAt)));
    }
  }
}

export async function me(deps: Deps, userId: string) {
  const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw unauthorized('auth.session_ended', 'Сессия завершена, войдите снова');
  const rows = await deps.db
    .select({ access: memberships.access, rights: memberships.rights, position: positions.name, property: properties })
    .from(memberships)
    .innerJoin(properties, eq(properties.id, memberships.propertyId))
    .leftJoin(positions, eq(positions.id, memberships.positionId))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(properties.name));
  return {
    id: user.id,
    login: user.login,
    fullName: user.fullName,
    phone: user.phone,
    hasPin: user.pinHash != null,
    totpEnabled: user.totpEnabledAt != null,
    totpRequired: user.totpRequired,
    totpSetupRequired: user.totpRequired && deps.config.REQUIRE_TOTP_FOR_PRIVILEGED && user.totpEnabledAt == null,
    mustChangePassword: user.mustChangePassword,
    properties: rows.map((r) => {
      const access = r.access as Access;
      const rights = effectiveRights(access, cleanRights(r.rights));
      return {
        id: r.property.id,
        name: r.property.name,
        timezone: r.property.timezone,
        currency: r.property.currency,
        access,
        accessLabel: ACCESS_LABELS[access],
        position: r.position,
        rights,
        permissions: [...permissionsFor(access, rights)],
      };
    }),
  };
}

export async function updateProfile(deps: Deps, userId: string, input: { fullName?: string | undefined; phone?: string | null | undefined }, meta: { ip: string | null; requestId: string }) {
  const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw unauthorized('auth.session_ended', 'Сессия завершена, войдите снова');
  const next = {
    ...(input.fullName !== undefined && input.fullName !== user.fullName ? { fullName: input.fullName } : {}),
    ...(input.phone !== undefined && (input.phone || null) !== user.phone ? { phone: input.phone || null } : {}),
  };
  if (!Object.keys(next).length) return;
  await deps.db
    .update(users)
    .set({ ...next, updatedAt: new Date(), version: user.version + 1 })
    .where(eq(users.id, userId));
  await audit(deps.db, scopeOf(user, meta), {
    action: 'user.profile',
    entityType: 'user',
    entityId: user.id,
    entityLabel: next.fullName ?? user.fullName,
    before: { fullName: user.fullName, phone: user.phone },
    after: { fullName: next.fullName ?? user.fullName, phone: 'phone' in next ? next.phone : user.phone },
  });
}

export async function changePassword(deps: Deps, userId: string, current: string, next: string, meta: { ip: string | null; requestId: string }) {
  const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw unauthorized('auth.session_ended', 'Сессия завершена, войдите снова');
  if (!(await verifySecret(current, user.passwordHash))) {
    throw badRequest('auth.password_wrong', user.mustChangePassword ? 'Временный пароль неверен' : 'Текущий пароль неверен');
  }
  if (current === next) throw badRequest('auth.password_same', 'Новый пароль совпадает с прежним');
  await deps.db
    .update(users)
    .set({ passwordHash: await hashSecret(next), passwordChangedAt: new Date(), mustChangePassword: false, updatedAt: new Date() })
    .where(eq(users.id, userId));
  await audit(deps.db, scopeOf(user, meta), { action: 'user.password_change', entityType: 'user', entityId: user.id, entityLabel: user.fullName });
}

export async function setPin(deps: Deps, userId: string, pin: string, meta: { ip: string | null; requestId: string }) {
  const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw unauthorized('auth.session_ended', 'Сессия завершена, войдите снова');
  await deps.db.update(users).set({ pinHash: await hashSecret(pin), updatedAt: new Date() }).where(eq(users.id, userId));
  await audit(deps.db, scopeOf(user, meta), { action: 'user.pin_change', entityType: 'user', entityId: user.id, entityLabel: user.fullName });
}

export async function totpSetup(deps: Deps, userId: string) {
  const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw unauthorized('auth.session_ended', 'Сессия завершена, войдите снова');
  if (user.totpEnabledAt) throw conflict('totp.already_enabled', 'Двухфакторный вход уже включён');
  const secret = generateTotpSecret();
  await deps.db.update(users).set({ totpSecret: secret }).where(eq(users.id, userId));
  return { secret, otpauthUrl: otpauthUrl(secret, user.login, 'Bizdin Auyl') };
}

export async function totpEnable(deps: Deps, userId: string, code: string, meta: { ip: string | null; requestId: string }) {
  const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || !user.totpSecret) throw badRequest('totp.not_started', 'Сначала получите ключ для приложения');
  if (!verifyTotp(user.totpSecret, code)) throw badRequest('totp.code_invalid', 'Код не подошёл, проверьте время на телефоне');
  await deps.db.update(users).set({ totpEnabledAt: new Date() }).where(eq(users.id, userId));
  await audit(deps.db, scopeOf(user, meta), { action: 'user.totp_enable', entityType: 'user', entityId: user.id, entityLabel: user.fullName });
}

export async function totpDisable(deps: Deps, userId: string, code: string, meta: { ip: string | null; requestId: string }) {
  const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || !user.totpSecret || !user.totpEnabledAt) throw badRequest('totp.not_enabled', 'Двухфакторный вход не включён');
  if (!verifyTotp(user.totpSecret, code)) throw badRequest('totp.code_invalid', 'Код не подошёл');
  await deps.db.update(users).set({ totpEnabledAt: null, totpSecret: null }).where(eq(users.id, userId));
  await audit(deps.db, scopeOf(user, meta), { action: 'user.totp_disable', entityType: 'user', entityId: user.id, entityLabel: user.fullName });
}
