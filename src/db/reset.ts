import { createDb } from './client.ts';
import { runMigrations } from './migrate.ts';
import { seed } from './seed.ts';

/**
 * Чистое демо: схема удаляется целиком, миграции и сид - заново. Только для
 * разработки: на проде данные не удаляются (ТЗ: «ничего не удаляется бесследно»).
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL не задан');
if (process.env.NODE_ENV === 'production') throw new Error('Сброс базы на проде запрещён');

const handle = createDb(url, { max: 1 });
try {
  await handle.sql.unsafe('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;');
} finally {
  await handle.close();
}
await runMigrations(url);
const again = createDb(url, { max: 2 });
try {
  await seed(again.db);
} finally {
  await again.close();
}
