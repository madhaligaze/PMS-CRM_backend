import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authOf, authScopeHook } from '../../core/guards.ts';
import { Problem } from '../../core/http.ts';
import { ACCESS, LEVELS, POWERS, SECTIONS } from '../../lib/access.ts';
import { unauthorized } from '../../lib/errors.ts';
import * as auth from './service.ts';

const REFRESH_COOKIE = 'ba_rt';
const COOKIE_PATH = '/api/v1/auth';

const Tokens = z
  .object({
    accessToken: z.string(),
    accessTokenExpiresAt: z.iso.datetime(),
    /** Только для мобильных клиентов. Веб получает refresh-токен в httpOnly-cookie. */
    refreshToken: z.string().optional(),
    refreshTokenExpiresAt: z.iso.datetime(),
  })
  .meta({ id: 'Tokens' });

const ClientType = z.enum(['web', 'mobile', 'kiosk']).default('mobile');

export const AccessEnum = z.enum(ACCESS).meta({ id: 'Access', description: 'owner - владелец, admin - администратор с полным доступом, staff - сотрудник с правами по разделам' });
export const LevelEnum = z.enum(LEVELS).meta({ id: 'AccessLevel' });

const sectionKeys = SECTIONS.map((s) => s.key) as [string, ...string[]];
const powerKeys = POWERS.map((p) => p.key) as [string, ...string[]];

export const RightsDto = z
  .object({
    sections: z.partialRecord(z.enum(sectionKeys), LevelEnum),
    powers: z.array(z.enum(powerKeys)),
  })
  .meta({ id: 'Rights', description: 'Права сотрудника: уровень по разделам и особые полномочия. Нет раздела - нет доступа.' });

export const MeDto = z
  .object({
    id: z.uuid(),
    login: z.string(),
    fullName: z.string(),
    phone: z.string().nullable(),
    hasPin: z.boolean(),
    totpEnabled: z.boolean(),
    totpRequired: z.boolean(),
    totpSetupRequired: z.boolean(),
    /** Пароль выдан управляющим: до смены работать в гостинице нельзя (403 auth.password_change_required). */
    mustChangePassword: z.boolean(),
    properties: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        timezone: z.string(),
        currency: z.string(),
        access: AccessEnum,
        accessLabel: z.string(),
        position: z.string().nullable(),
        rights: RightsDto,
        /** Внутренние права маршрутов: клиент прячет то, чего нельзя. */
        permissions: z.array(z.string()),
      }),
    ),
  })
  .meta({ id: 'Me' });

const PASSWORD = z.string().min(8, 'Пароль - не короче 8 знаков').max(200);
const LOGIN = z
  .string()
  .trim()
  .min(3, 'Логин - не короче 3 знаков')
  .max(60)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Логин - латиница, цифры, точка, дефис');

function metaOf(req: FastifyRequest, clientType: auth.ClientType) {
  const ua = req.headers['user-agent'];
  return { clientType, userAgent: typeof ua === 'string' ? ua : null, ip: req.ip ?? null, requestId: String(req.id) };
}

function deliver(reply: FastifyReply, tokens: auth.IssuedTokens, clientType: auth.ClientType, secure: boolean) {
  if (clientType === 'web') {
    reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure,
      sameSite: 'strict',
      path: COOKIE_PATH,
      expires: new Date(tokens.refreshTokenExpiresAt),
    });
    return {
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    };
  }
  return {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshToken: tokens.refreshToken,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
  };
}

/** Публичные маршруты: регистрация, вход, обновление токена, выход. */
export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const secure = app.deps.config.COOKIE_SECURE;

  app.get(
    '/setup',
    {
      schema: {
        tags: ['Вход'],
        summary: 'Нужна ли регистрация',
        description: 'true - в базе ещё нет гостиницы: клиент показывает регистрацию владельца вместо входа.',
        security: [],
        response: { 200: z.object({ needed: z.boolean() }) },
      },
    },
    async () => ({ needed: await auth.setupNeeded(app.deps) }),
  );

  app.post(
    '/setup',
    {
      schema: {
        tags: ['Вход'],
        summary: 'Регистрация гостиницы и её владельца',
        description:
          'Работает один раз, пока в базе нет ни одной гостиницы; затем 409 setup.done. Владелец сразу входит: ответ - как у входа. ' +
          'Сотрудников дальше заводит владелец в разделе «Сотрудники».',
        security: [],
        body: z.object({
          hotelName: z.string().trim().min(2, 'Название гостиницы - не короче 2 знаков').max(120),
          fullName: z.string().trim().min(3, 'Имя и фамилия - не короче 3 знаков').max(120),
          phone: z.string().trim().max(40).nullable().optional(),
          login: LOGIN,
          password: PASSWORD,
          client: ClientType,
        }),
        response: { 200: Tokens, 409: Problem },
      },
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const tokens = await auth.setup(app.deps, req.body, metaOf(req, req.body.client));
      return deliver(reply, tokens, req.body.client, secure);
    },
  );

  app.post(
    '/auth/login',
    {
      schema: {
        tags: ['Вход'],
        summary: 'Вход по логину и паролю',
        description:
          'Веб передаёт client=web и получает refresh-токен в httpOnly-cookie. Мобильный клиент получает его в теле ответа. ' +
          'Если у сотрудника включён второй фактор, без totpCode ответ 401 с code=auth.totp_required.',
        body: z.object({
          login: z.string().min(1).max(100),
          password: z.string().min(1).max(200),
          totpCode: z.string().max(10).optional(),
          client: ClientType,
        }),
        response: { 200: Tokens, 401: Problem },
      },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const tokens = await auth.login(app.deps, req.body, metaOf(req, req.body.client));
      return deliver(reply, tokens, req.body.client, secure);
    },
  );

  app.post(
    '/auth/refresh',
    {
      schema: {
        tags: ['Вход'],
        summary: 'Новая пара токенов по refresh-токену',
        description: 'Refresh-токен одноразовый. Повтор использованного токена отзывает все сессии этой цепочки.',
        body: z
          .object({ refreshToken: z.string().optional(), client: ClientType })
          .default({ client: 'mobile' }),
        response: { 200: Tokens, 401: Problem, 409: Problem },
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const client = req.body.client;
      const token = req.body.refreshToken ?? req.cookies[REFRESH_COOKIE];
      if (!token) throw unauthorized('auth.session_ended', 'Сессия завершена, войдите снова');
      const tokens = await auth.refresh(app.deps, token, metaOf(req, client));
      return deliver(reply, tokens, client, secure);
    },
  );

  app.post(
    '/auth/logout',
    {
      schema: {
        tags: ['Вход'],
        summary: 'Выход: отзыв сессии',
        body: z.object({ refreshToken: z.string().optional() }).default({}),
        response: { 204: z.undefined() },
      },
    },
    async (req, reply) => {
      const token = req.body.refreshToken ?? req.cookies[REFRESH_COOKIE] ?? null;
      let sessionId: string | null = null;
      const header = req.headers.authorization;
      if (header?.startsWith('Bearer ')) {
        try {
          sessionId = (await app.deps.tokens.verifyAccess(header.slice(7))).sid;
        } catch {
          sessionId = null;
        }
      }
      await auth.logout(app.deps, { refreshToken: token, sessionId });
      reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
      return reply.status(204).send();
    },
  );
};

/** Профиль текущего сотрудника. */
export const meRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', authScopeHook(app));

  app.get(
    '/me',
    { schema: { tags: ['Профиль'], summary: 'Текущий сотрудник, его гостиницы, доступ и права', response: { 200: MeDto } } },
    async (req) => auth.me(app.deps, authOf(req).userId),
  );

  app.patch(
    '/me',
    {
      schema: {
        tags: ['Профиль'],
        summary: 'Своё имя и телефон',
        body: z.object({ fullName: z.string().trim().min(3).max(120).optional(), phone: z.string().trim().max(40).nullable().optional() }),
        response: { 200: MeDto },
      },
    },
    async (req) => {
      const userId = authOf(req).userId;
      await auth.updateProfile(app.deps, userId, req.body, { ip: req.ip, requestId: String(req.id) });
      return auth.me(app.deps, userId);
    },
  );

  app.post(
    '/me/password',
    {
      schema: {
        tags: ['Профиль'],
        summary: 'Смена пароля',
        description: 'Временный пароль от управляющего меняется здесь же: currentPassword - он, после смены доступ к гостинице открывается.',
        body: z.object({ currentPassword: z.string().min(1), newPassword: PASSWORD }),
        response: { 204: z.undefined() },
      },
    },
    async (req, reply) => {
      await auth.changePassword(app.deps, authOf(req).userId, req.body.currentPassword, req.body.newPassword, {
        ip: req.ip,
        requestId: String(req.id),
      });
      return reply.status(204).send();
    },
  );

  app.post(
    '/me/pin',
    {
      schema: {
        tags: ['Профиль'],
        summary: 'PIN для отметки прихода на общем планшете',
        body: z.object({ pin: z.string().regex(/^\d{4,6}$/, 'PIN - от 4 до 6 цифр') }),
        response: { 204: z.undefined() },
      },
    },
    async (req, reply) => {
      await auth.setPin(app.deps, authOf(req).userId, req.body.pin, { ip: req.ip, requestId: String(req.id) });
      return reply.status(204).send();
    },
  );

  app.post(
    '/me/totp/setup',
    {
      schema: {
        tags: ['Профиль'],
        summary: 'Ключ для приложения-аутентификатора',
        response: { 200: z.object({ secret: z.string(), otpauthUrl: z.string() }) },
      },
    },
    async (req) => auth.totpSetup(app.deps, authOf(req).userId),
  );

  app.post(
    '/me/totp/enable',
    {
      schema: {
        tags: ['Профиль'],
        summary: 'Включить второй фактор: подтвердить кодом из приложения',
        body: z.object({ code: z.string().min(6).max(10) }),
        response: { 204: z.undefined() },
      },
    },
    async (req, reply) => {
      await auth.totpEnable(app.deps, authOf(req).userId, req.body.code, { ip: req.ip, requestId: String(req.id) });
      return reply.status(204).send();
    },
  );

  app.post(
    '/me/totp/disable',
    {
      schema: {
        tags: ['Профиль'],
        summary: 'Выключить второй фактор',
        body: z.object({ code: z.string().min(6).max(10) }),
        response: { 204: z.undefined() },
      },
    },
    async (req, reply) => {
      await auth.totpDisable(app.deps, authOf(req).userId, req.body.code, { ip: req.ip, requestId: String(req.id) });
      return reply.status(204).send();
    },
  );
};
