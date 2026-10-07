import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.ts';

export type Db = PostgresJsDatabase<typeof schema>;
/** Транзакция drizzle: тот же API, что у Db. Сервисы принимают любой из двух. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export type DbHandle = {
  db: Db;
  sql: postgres.Sql;
  close: () => Promise<void>;
};

export function createDb(url: string, opts: { max?: number } = {}): DbHandle {
  const sql = postgres(url, {
    max: opts.max ?? 10,
    // Даты без времени отдаём строками 'YYYY-MM-DD': никаких сдвигов из-за часовых поясов.
    types: {
      date: {
        to: 1082,
        from: [1082],
        serialize: (v: string) => v,
        parse: (v: string) => v,
      },
    },
    onnotice: () => {},
    connection: { application_name: 'bizdin-api' },
  });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}
