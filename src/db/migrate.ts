import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client.ts';

/** Папка с SQL-миграциями: рядом с исходниками в разработке и рядом с dist в образе. */
export function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../drizzle');
}

export async function runMigrations(url: string): Promise<void> {
  const handle = createDb(url, { max: 1 });
  try {
    // Advisory lock: при старте нескольких экземпляров миграции выполнит один.
    await handle.sql`select pg_advisory_lock(727001)`;
    await migrate(handle.db, { migrationsFolder: migrationsFolder() });
    await handle.sql`select pg_advisory_unlock(727001)`;
  } finally {
    await handle.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL не задан');
  await runMigrations(url);
  console.log('Миграции применены');
}
