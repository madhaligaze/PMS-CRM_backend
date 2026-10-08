import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  MIGRATE_ON_START: bool.default(false),
  /** Стенд для показа: при старте положить демо-данные, если база пустая. */
  SEED_DEMO_IF_EMPTY: bool.default(false),

  /** Секрет подписи access-токенов и ссылок на файлы. Не короче 32 символов. */
  JWT_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /**
   * Требовать двухфакторный вход от управляющего и бухгалтера (ТЗ). На проде
   * включено; для демо можно выключить, чтобы войти без приложения-аутентификатора.
   */
  REQUIRE_TOTP_FOR_PRIVILEGED: bool.default(true),

  /** Откуда разрешены запросы браузера. Через запятую. Мобильным клиентам CORS не нужен. */
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  COOKIE_SECURE: bool.default(false),

  /** Публичный адрес API: из него собираются ссылки на загрузку и скачивание файлов. */
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  FILES_DIR: z.string().default('.data/files'),

  /**
   * Драйвер фискальной кассы. Сейчас только mock: онлайн-ККМ с передачей чеков
   * через ОФД подключается после выбора кассы и уточнения требований КГД.
   */
  FISCAL_DRIVER: z.enum(['mock']).default('mock'),

  MIN_CLIENT_VERSION_IOS: z.string().default('0.0.0'),
  MIN_CLIENT_VERSION_ANDROID: z.string().default('0.0.0'),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Неверная конфигурация окружения:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
