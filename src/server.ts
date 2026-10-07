import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { startScheduler } from './core/scheduler.ts';
import { runMigrations } from './db/migrate.ts';

const config = loadConfig();

if (config.MIGRATE_ON_START) {
  await runMigrations(config.DATABASE_URL);
}

const app = await buildApp(config);
await app.deps.events.start();
const stopScheduler = startScheduler(app);

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'остановка');
  stopScheduler();
  await app.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
