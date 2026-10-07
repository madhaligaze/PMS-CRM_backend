import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

/**
 * Пишет openapi.json - контракт API. Из него генерируются типизированные
 * клиенты: TypeScript для веба, Swift/Kotlin/Dart для мобильных приложений.
 * База для этого не нужна: соединение создаётся лениво и не открывается.
 */
const config = loadConfig({
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://openapi:openapi@127.0.0.1:1/openapi',
  JWT_SECRET: process.env.JWT_SECRET ?? 'openapi-generation-only-secret-000000',
  PUBLIC_API_URL: process.env.PUBLIC_API_URL ?? 'http://localhost:4000',
});
const app = await buildApp(config, { logger: false });
await app.ready();
const spec = app.swagger();
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../openapi.json');
await writeFile(out, JSON.stringify(spec, null, 2) + '\n');
console.log(`openapi.json: ${Object.keys(spec.paths ?? {}).length} путей -> ${out}`);
await app.close();
