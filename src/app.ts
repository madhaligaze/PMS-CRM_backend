import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { Deps } from './core/deps.ts';
import { EventHub } from './core/events.ts';
import { MockFiscalDriver } from './core/fiscal.ts';
import { propertyScopeHook } from './core/guards.ts';
import { errorHandler } from './core/http.ts';
import { registerIdempotency } from './core/idempotency.ts';
import { pruneUnusedSchemas } from './core/openapi-prune.ts';
import { LocalFileStorage } from './core/storage.ts';
import { createDb } from './db/client.ts';
import { newId } from './lib/ids.ts';
import { TokenService } from './lib/tokens.ts';
import { attendanceRoutes, kioskRoutes } from './modules/attendance/routes.ts';
import { auditRoutes } from './modules/audit/routes.ts';
import { authRoutes, meRoutes } from './modules/auth/routes.ts';
import { bookingRoutes } from './modules/bookings/routes.ts';
import { cashRoutes } from './modules/cash/routes.ts';
import { dashboardRoutes } from './modules/dashboard/routes.ts';
import { eventRoutes } from './modules/events/routes.ts';
import { fileContentRoutes, fileRoutes } from './modules/files/routes.ts';
import { guestRoutes } from './modules/guests/routes.ts';
import { housekeepingRoutes } from './modules/housekeeping/routes.ts';
import { maintenanceRoutes } from './modules/maintenance/routes.ts';
import { API_VERSION, documentRoutes, metaRoutes } from './modules/meta/routes.ts';
import { propertyRoutes } from './modules/property/routes.ts';
import { rateRoutes } from './modules/rates/routes.ts';
import { reportRoutes } from './modules/reports/routes.ts';
import { staffRoutes } from './modules/staff/routes.ts';

// Сообщения проверки запросов - по-русски: клиенты показывают их людям.
z.config(z.locales.ru());

export async function buildApp(config: Config, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
            ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } } : {}),
          },
    genReqId: () => newId(),
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    routerOptions: { ignoreTrailingSlash: true },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const handle = createDb(config.DATABASE_URL, { max: config.DATABASE_POOL_MAX });
  const tokens = new TokenService(config.JWT_SECRET, config.ACCESS_TOKEN_TTL_SECONDS);
  const deps: Deps = {
    config,
    db: handle.db,
    sql: handle.sql,
    tokens,
    storage: new LocalFileStorage(config.FILES_DIR, config.PUBLIC_API_URL, tokens),
    fiscal: new MockFiscalDriver(),
    events: new EventHub(handle.sql, app.log),
  };
  app.decorate('deps', deps);
  app.decorateRequest('auth', null);
  app.decorateRequest('ctx', null);
  app.decorateRequest('idempotency', null);

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).type('application/problem+json').send({
      type: 'about:blank',
      status: 404,
      code: 'route.not_found',
      title: 'Такого адреса в API нет',
      requestId: String(req.id),
    }),
  );

  const origins = config.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || origins.includes(origin)),
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type', 'If-Match', 'Idempotency-Key', 'X-Requested-With'],
    exposedHeaders: ['ETag', 'Idempotent-Replayed', 'Content-Disposition'],
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  });
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } });
  await app.register(cookie);
  // В тестах десятки входов подряд с одного адреса - ограничение там мешает проверять логику.
  if (config.NODE_ENV !== 'test') {
    await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  }

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Bizdin Auyl API',
        version: API_VERSION,
        description:
          'PMS + CRM гостиницы. Контракт для веба и будущих мобильных приложений.\n\n' +
          '- Версия в пути: /api/v1. Поля только добавляются; удаление или переименование - новая версия.\n' +
          '- Вход: access-токен (Bearer, 15 минут) + одноразовый refresh-токен. Веб хранит refresh в httpOnly-cookie.\n' +
          '- Создание брони, оплаты, начисления: заголовок Idempotency-Key, повтор не создаст дубль.\n' +
          '- Изменение: If-Match с версией записи, иначе 412 при одновременной правке.\n' +
          '- Ошибки: application/problem+json со стабильным полем code.\n' +
          '- Деньги - целые числа в минимальных единицах валюты гостиницы (тиын: 100 тиын = 1 тенге). Даты проживания - YYYY-MM-DD по времени гостиницы.',
      },
      servers: [{ url: config.PUBLIC_API_URL }],
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
    transformObject: (doc) => pruneUnusedSchemas(jsonSchemaTransformObject(doc)),
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  registerIdempotency(app);

  app.get('/health/live', { schema: { hide: true }, logLevel: 'silent' }, async () => ({ ok: true }));
  app.get('/health/ready', { schema: { hide: true }, logLevel: 'silent' }, async (_req, reply) => {
    try {
      await deps.sql`select 1`;
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });

  await app.register(
    async (api) => {
      await api.register(metaRoutes);
      await api.register(authRoutes);
      await api.register(meRoutes);
      await api.register(kioskRoutes);
      await api.register(fileContentRoutes);
      await api.register(
        async (scoped) => {
          scoped.addHook('onRequest', propertyScopeHook(scoped));
          await scoped.register(propertyRoutes);
          await scoped.register(rateRoutes);
          await scoped.register(guestRoutes);
          await scoped.register(bookingRoutes);
          await scoped.register(cashRoutes);
          await scoped.register(housekeepingRoutes);
          await scoped.register(maintenanceRoutes);
          await scoped.register(attendanceRoutes);
          await scoped.register(staffRoutes);
          await scoped.register(reportRoutes);
          await scoped.register(auditRoutes);
          await scoped.register(dashboardRoutes);
          await scoped.register(eventRoutes);
          await scoped.register(fileRoutes);
          await scoped.register(documentRoutes);
        },
        { prefix: '/properties/:propertyId' },
      );
    },
    { prefix: '/api/v1' },
  );

  app.addHook('onClose', async () => {
    await deps.events.stop();
    await handle.close();
  });

  return app;
}
