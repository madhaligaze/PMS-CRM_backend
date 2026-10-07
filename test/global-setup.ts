import postgres from 'postgres';
import { createDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { seed } from '../src/db/seed.ts';
import { TEST_DATABASE_URL } from './helpers.ts';

/**
 * Отдельная база bizdin_test в том же Postgres, что и для разработки
 * (docker compose up -d db). Перед прогоном - чистая схема, миграции и демо.
 */
export default async function setup() {
  const admin = postgres(TEST_DATABASE_URL.replace(/\/[^/]+$/, '/postgres'), { max: 1, onnotice: () => {} });
  try {
    const [exists] = await admin`select 1 from pg_database where datname = 'bizdin_test'`;
    if (!exists) await admin.unsafe('create database bizdin_test');
  } finally {
    await admin.end();
  }
  const handle = createDb(TEST_DATABASE_URL, { max: 1 });
  await handle.sql.unsafe('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;');
  await handle.close();
  await runMigrations(TEST_DATABASE_URL);
  const db = createDb(TEST_DATABASE_URL, { max: 2 });
  await seed(db.db, () => {});
  await db.close();
}
