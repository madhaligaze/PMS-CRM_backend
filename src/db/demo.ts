import postgres from 'postgres';
import { createDb } from './client.ts';
import { seed } from './seed.ts';

/**
 * Демо-данные при старте API (SEED_DEMO_IF_EMPTY=true): стенд для показа без
 * ручной подготовки. Сид пишет только в пустую базу - где уже есть гостиница,
 * ничего не меняется. Блокировка не даёт двум экземплярам засеять базу дважды.
 *
 * Пароль демо-сотрудников общий и известный (demo12345): на открытом адресе
 * это стенд для показа, а не рабочая гостиница.
 */
export async function seedDemoIfEmpty(url: string, log: (msg: string) => void): Promise<void> {
  const lock = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await lock`select pg_advisory_lock(727003)`;
    const handle = createDb(url, { max: 2 });
    try {
      await seed(handle.db, log);
    } finally {
      await handle.close();
    }
    await lock`select pg_advisory_unlock(727003)`;
  } finally {
    await lock.end();
  }
}
