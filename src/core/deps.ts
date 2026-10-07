import type { Config } from '../config.ts';
import type { DbHandle } from '../db/client.ts';
import type { TokenService } from '../lib/tokens.ts';
import type { EventHub } from './events.ts';
import type { FileStorage } from './storage.ts';
import type { FiscalDriver } from './fiscal.ts';

/** Зависимости сервисов. Собираются один раз при старте и передаются явно. */
export type Deps = {
  config: Config;
  db: DbHandle['db'];
  sql: DbHandle['sql'];
  tokens: TokenService;
  storage: FileStorage;
  fiscal: FiscalDriver;
  events: EventHub;
};
