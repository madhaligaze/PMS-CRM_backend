import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://bizdin:bizdin@localhost:5433/bizdin_test';

export async function makeApp(): Promise<FastifyInstance> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    JWT_SECRET: 'test-secret-test-secret-test-secret-00',
    LOG_LEVEL: 'silent',
    REQUIRE_TOTP_FOR_PRIVILEGED: 'false',
    FILES_DIR: '.data/test-files',
    DATABASE_POOL_MAX: '4',
  });
  const app = await buildApp(config, { logger: false });
  await app.ready();
  return app;
}

type Res<T> = Promise<{ status: number; body: T; headers: Record<string, unknown> }>;

export type Api = {
  token: string;
  propertyId: string;
  get: <T = any>(path: string, headers?: Record<string, string>) => Res<T>;
  post: <T = any>(path: string, payload?: unknown, headers?: Record<string, string>) => Res<T>;
  patch: <T = any>(path: string, payload?: unknown, headers?: Record<string, string>) => Res<T>;
  del: <T = any>(path: string, payload?: unknown, headers?: Record<string, string>) => Res<T>;
};

/** Вход сотрудником и клиент к его гостинице: пути - относительно /properties/:id. */
export async function as(app: FastifyInstance, login: string, password = 'demo12345'): Promise<Api> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login, password, client: 'mobile' } });
  if (res.statusCode !== 200) throw new Error(`login ${login}: ${res.statusCode} ${res.body}`);
  const token = (res.json() as { accessToken: string }).accessToken;
  const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } });
  const propertyId = (me.json() as { properties: { id: string }[] }).properties[0]!.id;
  const base = `/api/v1/properties/${propertyId}`;
  const run = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const r = await app.inject({
      method,
      url: path.startsWith('/api/') ? path : base + path,
      headers: { authorization: `Bearer ${token}`, ...headers },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
    let body: any = r.body;
    try {
      body = r.body ? r.json() : null;
    } catch {
      /* CSV и прочее не-JSON */
    }
    return { status: r.statusCode, body, headers: r.headers as Record<string, unknown> };
  };
  return {
    token,
    propertyId,
    get: (p, h) => run('GET', p, undefined, h),
    post: (p, b, h) => run('POST', p, b ?? {}, h),
    patch: (p, b, h) => run('PATCH', p, b ?? {}, h),
    del: (p, b, h) => run('DELETE', p, b ?? {}, h),
  };
}

/** Попытка входа без исключения: тесты проверяют и отказы. */
export async function tryLogin(app: FastifyInstance, login: string, password: string) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login, password, client: 'mobile' } });
  return { status: res.statusCode, body: res.json() as any };
}

export function plusDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
