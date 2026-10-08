/**
 * API для e2e-прогона: своя база, перед стартом - чистая схема, миграции и
 * демо-данные. E2E_EMPTY=1 - без демо: на пустой базе проверяется регистрация
 * гостиницы. Только для тестов: настоящую базу так не сбрасывают.
 *
 *   DATABASE_URL=postgres://.../bizdin_e2e PORT=4100 tsx test/e2e-server.ts
 */
import postgres from 'postgres';
import { createDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { seed } from '../src/db/seed.ts';

const url = process.env.DATABASE_URL ?? 'postgres://bizdin:bizdin@localhost:5433/bizdin_e2e';
const name = new URL(url).pathname.slice(1);
if (!/^[a-z0-9_]+$/.test(name) || !/e2e|test/.test(name)) throw new Error(`e2e-сервер работает только с тестовой базой, а не «${name}»`);

const admin = postgres(url.replace(/\/[^/]+$/, '/postgres'), { max: 1, onnotice: () => {} });
try {
  const [exists] = await admin`select 1 from pg_database where datname = ${name}`;
  if (!exists) await admin.unsafe(`create database ${name}`);
} finally {
  await admin.end();
}

const handle = createDb(url, { max: 1 });
try {
  await handle.sql.unsafe('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;');
} finally {
  await handle.close();
}
await runMigrations(url);
if (process.env.E2E_EMPTY !== '1') {
  const db = createDb(url, { max: 2 });
  try {
    await seed(db.db, () => {});
  } finally {
    await db.close();
  }
}

Object.assign(process.env, {
  DATABASE_URL: url,
  NODE_ENV: process.env.NODE_ENV ?? 'test',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  JWT_SECRET: process.env.JWT_SECRET ?? 'e2e-secret-e2e-secret-e2e-secret-000000',
  MIGRATE_ON_START: 'false',
  REQUIRE_TOTP_FOR_PRIVILEGED: 'false',
  FILES_DIR: process.env.FILES_DIR ?? '.data/e2e-files',
});
await import('../src/server.ts');
