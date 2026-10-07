import { and, asc, count, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../core/audit.ts';
import type { PropertyContext } from '../../core/context.ts';
import { ctxOf } from '../../core/guards.ts';
import { iso } from '../../core/http.ts';
import type { DbOrTx } from '../../db/client.ts';
import { memberships, positions, sessions, users } from '../../db/schema/index.ts';
import {
  ACCESS_LABELS,
  accessCatalog,
  cleanRights,
  effectiveRights,
  LEVELS,
  levelOf,
  NO_RIGHTS,
  POWERS,
  rightsDiff,
  SECTIONS,
  type Access,
  type Rights,
} from '../../lib/access.ts';
import { hashSecret } from '../../lib/crypto.ts';
import { conflict, forbidden, notFound } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { AccessEnum, RightsDto } from '../auth/routes.ts';
import { isClockedIn } from '../cash/service.ts';
import { listPositions, randomPin, resolvePosition, temporaryPassword } from './service.ts';

const P = z.object({ propertyId: z.uuid() });
const PI = P.extend({ id: z.uuid() });

const RANK = { none: 0, view: 1, edit: 2 } as const;

export const PositionDto = z
  .object({
    id: z.uuid(),
    name: z.string(),
    rights: RightsDto,
    requireTotp: z.boolean(),
    employees: z.number().int().describe('Сколько работающих сотрудников гостиницы на этой должности'),
  })
  .meta({ id: 'Position' });

export const StaffDto = z
  .object({
    id: z.uuid(),
    login: z.string(),
    fullName: z.string(),
    phone: z.string().nullable(),
    access: AccessEnum,
    accessLabel: z.string(),
    position: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    /** У владельца и администратора - все права. */
    rights: RightsDto,
    isActive: z.boolean(),
    archivedAt: z.iso.datetime().nullable(),
    hasPin: z.boolean(),
    totpEnabled: z.boolean(),
    totpRequired: z.boolean(),
    mustChangePassword: z.boolean(),
    lastLoginAt: z.iso.datetime().nullable(),
    clockedIn: z.boolean(),
    createdAt: z.iso.datetime(),
    version: z.number().int(),
  })
  .meta({ id: 'Staff' });

const Secrets = z
  .object({
    temporaryPassword: z.string().nullable().describe('Показывается один раз: при первом входе сотрудник задаёт свой пароль'),
    pin: z.string().nullable().describe('PIN для планшета прихода - показывается один раз'),
  })
  .meta({ id: 'StaffSecrets' });

const PositionInput = {
  positionId: z.uuid().nullable().optional(),
  /** Новое название заводит должность сразу - список растёт из найма. */
  positionName: z.string().trim().max(80).nullable().optional(),
};

type Row = {
  u: typeof users.$inferSelect;
  access: string;
  rights: unknown;
  positionId: string | null;
  positionName: string | null;
};

async function rowsOf(db: DbOrTx, propertyId: string, where: { id?: string; archived?: boolean }): Promise<Row[]> {
  return db
    .select({ u: users, access: memberships.access, rights: memberships.rights, positionId: positions.id, positionName: positions.name })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(positions, eq(positions.id, memberships.positionId))
    .where(
      and(
        eq(memberships.propertyId, propertyId),
        ...(where.id ? [eq(users.id, where.id)] : []),
        ...(where.archived === undefined ? [] : [where.archived ? isNotNull(users.archivedAt) : isNull(users.archivedAt)]),
      ),
    )
    .orderBy(asc(users.fullName));
}

async function dto(db: DbOrTx, propertyId: string, r: Row) {
  const access = r.access as Access;
  return {
    id: r.u.id,
    login: r.u.login,
    fullName: r.u.fullName,
    phone: r.u.phone,
    access,
    accessLabel: ACCESS_LABELS[access],
    position: r.positionId && r.positionName ? { id: r.positionId, name: r.positionName } : null,
    rights: effectiveRights(access, cleanRights(r.rights)),
    isActive: r.u.isActive,
    archivedAt: iso(r.u.archivedAt),
    hasPin: r.u.pinHash != null,
    totpEnabled: r.u.totpEnabledAt != null,
    totpRequired: r.u.totpRequired,
    mustChangePassword: r.u.mustChangePassword,
    lastLoginAt: iso(r.u.lastLoginAt),
    clockedIn: r.u.archivedAt ? false : await isClockedIn(db, propertyId, r.u.id),
    createdAt: r.u.createdAt.toISOString(),
    version: r.u.version,
  };
}

async function one(db: DbOrTx, propertyId: string, id: string) {
  const [row] = await rowsOf(db, propertyId, { id });
  if (!row) throw notFound('user.not_found', 'Сотрудник не найден');
  return row;
}

/**
 * Кто кем управляет. Владельцем - только он сам (через профиль), администраторами -
 * владелец; себе доступ и права не меняют, чтобы не запереть самого себя.
 */
function assertManageable(ctx: PropertyContext, target: Row, what: 'edit' | 'access') {
  const targetAccess = target.access as Access;
  if (targetAccess === 'owner') throw forbidden('staff.owner', 'Учёткой владельца управляет только он сам', 'Имя, телефон и пароль владелец меняет в профиле.');
  if (targetAccess === 'admin' && ctx.access !== 'owner') throw forbidden('staff.admin', 'Администраторами управляет владелец');
  if (what === 'access' && target.u.id === ctx.actor.id) throw conflict('staff.self', 'Свой доступ и права меняет владелец или другой администратор');
}

/** Прибавить человеку можно только то, что есть у раздающего. Сужать - сколько угодно. */
function assertGrantable(ctx: PropertyContext, current: Rights, wanted: Rights) {
  if (ctx.access !== 'staff') return;
  for (const s of SECTIONS) {
    const want = levelOf(wanted, s.key);
    if (RANK[want] <= RANK[levelOf(current, s.key)]) continue;
    if (RANK[want] > RANK[levelOf(ctx.rights, s.key)]) {
      throw forbidden('staff.rights_above_own', `${s.title}: выше ваших прав не открыть`, 'Открыть больше, чем есть у вас, может владелец или администратор.');
    }
  }
  for (const key of wanted.powers) {
    if (current.powers.includes(key) || ctx.rights.powers.includes(key)) continue;
    const title = POWERS.find((p) => p.key === key)?.title ?? key;
    throw forbidden('staff.rights_above_own', `${title}: этого полномочия нет у вас самих`, 'Его может дать владелец или администратор.');
  }
}

export const staffRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = app.deps.db;

  // ── Каталог прав и должности ─────────────────────────────────────────────

  app.get(
    '/access/catalog',
    {
      schema: {
        tags: ['Персонал'],
        summary: 'Разделы и полномочия для экрана прав',
        params: P,
        response: {
          200: z.object({
            sections: z.array(z.object({ key: z.string(), title: z.string(), group: z.string(), levels: z.array(z.enum(LEVELS)), hint: z.string() })),
            powers: z.array(z.object({ key: z.string(), title: z.string(), hint: z.string() })),
          }),
        },
      },
      config: { permission: 'staff.view' },
    },
    async () => accessCatalog(),
  );

  async function positionDtos(ctx: PropertyContext) {
    const list = await listPositions(db, ctx.orgId);
    const counts = await db
      .select({ positionId: memberships.positionId, n: count() })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.propertyId, ctx.propertyId), isNull(users.archivedAt)))
      .groupBy(memberships.positionId);
    return list.map((p) => ({
      id: p.id,
      name: p.name,
      rights: cleanRights(p.rights),
      requireTotp: p.requireTotp,
      employees: counts.find((c) => c.positionId === p.id)?.n ?? 0,
    }));
  }

  app.get(
    '/positions',
    { schema: { tags: ['Персонал'], summary: 'Должности: подпись и права по умолчанию', params: P, response: { 200: z.array(PositionDto) } }, config: { permission: 'staff.view' } },
    async (req) => positionDtos(ctxOf(req)),
  );

  app.post(
    '/positions',
    {
      schema: {
        tags: ['Персонал'],
        summary: 'Новая должность',
        params: P,
        body: z.object({ name: z.string().trim().min(2).max(80), rights: RightsDto.optional(), requireTotp: z.boolean().optional() }),
        response: { 201: PositionDto },
      },
      config: { permission: 'staff.manage' },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      const rights = cleanRights(req.body.rights ?? NO_RIGHTS);
      assertGrantable(ctx, NO_RIGHTS, rights);
      const id = await db.transaction(async (tx) => {
        const { row, created } = await resolvePosition(tx, ctx.orgId, { positionName: req.body.name }, rights);
        if (!row) throw conflict('position.name_empty', 'Укажите название');
        if (!created) throw conflict('position.exists', `Должность «${row.name}» уже есть`);
        if (req.body.requireTotp) await tx.update(positions).set({ requireTotp: true }).where(eq(positions.id, row.id));
        await audit(tx, ctx, { action: 'position.create', entityType: 'position', entityId: row.id, entityLabel: row.name });
        return row.id;
      });
      const list = await positionDtos(ctx);
      return reply.status(201).send(list.find((p) => p.id === id)!);
    },
  );

  app.patch(
    '/positions/:id',
    {
      schema: {
        tags: ['Персонал'],
        summary: 'Изменить должность: название, права по умолчанию, порядок',
        description: 'Права людей на должности не меняются: применить их ко всем - отдельным запросом /apply.',
        params: PI,
        body: z.object({
          name: z.string().trim().min(2).max(80).optional(),
          rights: RightsDto.optional(),
          requireTotp: z.boolean().optional(),
          sort: z.number().int().min(0).max(10_000).optional(),
        }),
        response: { 200: PositionDto },
      },
      config: { permission: 'staff.manage' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      await db.transaction(async (tx) => {
        const [p] = await tx.select().from(positions).where(and(eq(positions.id, req.params.id), eq(positions.orgId, ctx.orgId), isNull(positions.archivedAt)));
        if (!p) throw notFound('position.not_found', 'Такой должности нет');
        const before = cleanRights(p.rights);
        const rights = req.body.rights ? cleanRights(req.body.rights) : before;
        assertGrantable(ctx, before, rights);
        const name = req.body.name?.replace(/\s+/g, ' ');
        if (name && name.toLowerCase() !== p.name.toLowerCase()) {
          const [dup] = await tx
            .select({ id: positions.id })
            .from(positions)
            .where(and(eq(positions.orgId, ctx.orgId), isNull(positions.archivedAt), sql`lower(${positions.name}) = lower(${name})`));
          if (dup) throw conflict('position.exists', `Должность «${name}» уже есть`);
        }
        await tx
          .update(positions)
          .set({
            ...(name ? { name } : {}),
            rights,
            ...(req.body.requireTotp !== undefined ? { requireTotp: req.body.requireTotp } : {}),
            ...(req.body.sort !== undefined ? { sort: req.body.sort } : {}),
            updatedAt: new Date(),
          })
          .where(eq(positions.id, p.id));
        await audit(tx, ctx, {
          action: 'position.update',
          entityType: 'position',
          entityId: p.id,
          entityLabel: name ?? p.name,
          changes: {
            ...(name && name !== p.name ? { name: [p.name, name] as [string, string] } : {}),
            ...rightsDiff(before, rights),
            ...(req.body.requireTotp !== undefined && req.body.requireTotp !== p.requireTotp ? { 'Второй фактор': [p.requireTotp ? 'да' : 'нет', req.body.requireTotp ? 'да' : 'нет'] as [string, string] } : {}),
          },
        });
      });
      return (await positionDtos(ctx)).find((p) => p.id === req.params.id)!;
    },
  );

  app.delete(
    '/positions/:id',
    {
      schema: {
        tags: ['Персонал'],
        summary: 'Убрать должность из списка',
        description: 'Нельзя, пока на ней работают люди: 409 position.in_use со списком в detail.',
        params: PI,
        response: { 204: z.undefined() },
      },
      config: { permission: 'staff.manage' },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      await db.transaction(async (tx) => {
        const [p] = await tx.select().from(positions).where(and(eq(positions.id, req.params.id), eq(positions.orgId, ctx.orgId), isNull(positions.archivedAt)));
        if (!p) throw notFound('position.not_found', 'Такой должности нет');
        const holders = await tx
          .select({ name: users.fullName })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(and(eq(memberships.positionId, p.id), isNull(users.archivedAt)));
        if (holders.length) {
          throw conflict('position.in_use', `На должности работают люди: ${holders.length}`, `Сначала переведите их на другую: ${holders.map((h) => h.name).join(', ')}.`);
        }
        await tx.update(positions).set({ archivedAt: new Date() }).where(eq(positions.id, p.id));
        await audit(tx, ctx, { action: 'position.archive', entityType: 'position', entityId: p.id, entityLabel: p.name });
      });
      return reply.status(204).send();
    },
  );

  app.post(
    '/positions/:id/apply',
    {
      schema: {
        tags: ['Персонал'],
        summary: 'Права должности - всем, кто на ней работает',
        description: 'Владельца и администраторов не трогает: у них и так всё. Ответ - сколько сотрудников получили права.',
        params: PI,
        response: { 200: z.object({ updated: z.number().int() }) },
      },
      config: { permission: 'staff.manage' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      return db.transaction(async (tx) => {
        const [p] = await tx.select().from(positions).where(and(eq(positions.id, req.params.id), eq(positions.orgId, ctx.orgId), isNull(positions.archivedAt)));
        if (!p) throw notFound('position.not_found', 'Такой должности нет');
        const rights = cleanRights(p.rights);
        const holders = (await rowsOf(tx, ctx.propertyId, { archived: false })).filter((r) => r.positionId === p.id && r.access === 'staff' && r.u.id !== ctx.actor.id);
        let updated = 0;
        for (const h of holders) {
          const before = cleanRights(h.rights);
          const changes = rightsDiff(before, rights);
          if (!Object.keys(changes).length) continue;
          assertGrantable(ctx, before, rights);
          await tx.update(memberships).set({ rights }).where(and(eq(memberships.userId, h.u.id), eq(memberships.propertyId, ctx.propertyId)));
          await tx.update(users).set({ totpRequired: p.requireTotp || h.u.totpRequired, updatedAt: new Date(), version: h.u.version + 1 }).where(eq(users.id, h.u.id));
          await audit(tx, ctx, { action: 'staff.rights', entityType: 'user', entityId: h.u.id, entityLabel: h.u.fullName, changes, reason: `Права должности «${p.name}»` });
          updated += 1;
        }
        await audit(tx, ctx, { action: 'position.apply', entityType: 'position', entityId: p.id, entityLabel: p.name, changes: { updated: [null, updated] } });
        return { updated };
      });
    },
  );

  // ── Сотрудники ──────────────────────────────────────────────────────────

  app.get(
    '/staff',
    {
      schema: {
        tags: ['Персонал'],
        summary: 'Сотрудники гостиницы',
        description: 'archived=true - уволенные: их можно вернуть.',
        params: P,
        // stringbool, не coerce.boolean: тот превращает строку «false» в true.
        querystring: z.object({ archived: z.stringbool().default(false) }),
        response: { 200: z.array(StaffDto) },
      },
      config: { permission: 'staff.view' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const rows = await rowsOf(db, ctx.propertyId, { archived: req.query.archived });
      return Promise.all(rows.map((r) => dto(db, ctx.propertyId, r)));
    },
  );

  app.get(
    '/staff/:id',
    { schema: { tags: ['Персонал'], summary: 'Сотрудник', params: PI, response: { 200: StaffDto } }, config: { permission: 'staff.view' } },
    async (req) => {
      const ctx = ctxOf(req);
      return dto(db, ctx.propertyId, await one(db, ctx.propertyId, req.params.id));
    },
  );

  app.get(
    '/staff/directory',
    {
      schema: {
        tags: ['Персонал'],
        summary: 'Короткий справочник для выбора: кому передать смену, кто утвердил спеццену, кому поручить уборку',
        params: P,
        response: {
          200: z.array(
            z.object({ id: z.uuid(), fullName: z.string(), position: z.string().nullable(), canApproveSpecialPrice: z.boolean(), cleans: z.boolean() }),
          ),
        },
      },
      config: { permission: ['cash.shift', 'booking.create', 'hk.assign', 'staff.view', 'maintenance.work'] },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const rows = (await rowsOf(db, ctx.propertyId, { archived: false })).filter((r) => r.u.isActive);
      return rows.map((r) => {
        const access = r.access as Access;
        const rights = effectiveRights(access, cleanRights(r.rights));
        return {
          id: r.u.id,
          fullName: r.u.fullName,
          position: r.positionName ?? (access === 'staff' ? null : ACCESS_LABELS[access]),
          canApproveSpecialPrice: rights.powers.includes('special_price_approve'),
          cleans: access === 'staff' && (levelOf(rights, 'cleaning') === 'edit' || levelOf(rights, 'housekeeping') === 'edit'),
        };
      });
    },
  );

  app.post(
    '/staff',
    {
      schema: {
        tags: ['Персонал'],
        summary: 'Нанять сотрудника',
        description:
          'Права - из должности, если не переданы. Без пароля выдаётся временный: он в ответе один раз, при первом входе сотрудник задаёт свой. ' +
          'Администратора назначает только владелец; сотрудник с правом «Сотрудники и права» даёт права не выше своих.',
        params: P,
        body: z.object({
          fullName: z.string().trim().min(3, 'Имя и фамилия - не короче 3 знаков').max(120),
          phone: z.string().trim().max(40).nullable().optional(),
          login: z
            .string()
            .trim()
            .min(3, 'Логин - не короче 3 знаков')
            .max(60)
            .regex(/^[a-zA-Z0-9._-]+$/, 'Логин - латиница, цифры, точка, дефис'),
          ...PositionInput,
          access: z.enum(['staff', 'admin']).default('staff'),
          rights: RightsDto.optional(),
          requireTotp: z.boolean().optional(),
          password: z.string().min(8).max(200).optional(),
          pin: z.string().regex(/^\d{4,6}$/, 'PIN - от 4 до 6 цифр').optional(),
        }),
        response: { 201: z.object({ employee: StaffDto, secrets: Secrets }) },
      },
      config: { permission: 'staff.manage', idempotent: true },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      const body = req.body;
      if (body.access === 'admin' && ctx.access !== 'owner') throw forbidden('staff.admin', 'Администратора назначает владелец');
      const id = newId();
      const password = body.password ?? temporaryPassword();
      const pin = body.pin ?? randomPin();
      await db.transaction(async (tx) => {
        const [dup] = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.orgId, ctx.orgId), sql`lower(${users.login}) = lower(${body.login})`));
        if (dup) throw conflict('staff.login_taken', `Логин ${body.login} уже занят`, 'Придумайте другой: например, имя и первую букву фамилии.');
        const requested = body.rights ? cleanRights(body.rights) : null;
        const { row: position } = await resolvePosition(tx, ctx.orgId, body, requested ?? NO_RIGHTS);
        const rights = body.access === 'admin' ? NO_RIGHTS : (requested ?? (position ? cleanRights(position.rights) : NO_RIGHTS));
        assertGrantable(ctx, NO_RIGHTS, rights);
        const totpRequired = body.requireTotp ?? (body.access === 'admin' || (position?.requireTotp ?? false));
        await tx.insert(users).values({
          id,
          orgId: ctx.orgId,
          login: body.login,
          fullName: body.fullName,
          phone: body.phone || null,
          passwordHash: await hashSecret(password),
          mustChangePassword: !body.password,
          pinHash: await hashSecret(pin),
          totpRequired,
        });
        await tx.insert(memberships).values({ userId: id, propertyId: ctx.propertyId, access: body.access, positionId: position?.id ?? null, rights });
        await audit(tx, ctx, {
          action: 'staff.create',
          entityType: 'user',
          entityId: id,
          entityLabel: body.fullName,
          changes: {
            login: [null, body.login],
            ...(position ? { position: [null, position.name] as [null, string] } : {}),
            ...(body.access === 'admin' ? { access: [null, ACCESS_LABELS.admin] as [null, string] } : rightsDiff(NO_RIGHTS, rights)),
          },
        });
      });
      const employee = await dto(db, ctx.propertyId, await one(db, ctx.propertyId, id));
      return reply.status(201).send({ employee, secrets: { temporaryPassword: body.password ? null : password, pin: body.pin ? null : pin } });
    },
  );

  app.patch(
    '/staff/:id',
    {
      schema: {
        tags: ['Персонал'],
        summary: 'Изменить сотрудника: имя, телефон, должность, доступ, права, блокировка',
        description:
          'Перевод на другую должность меняет права, только если applyPositionRights=true. Блокировка завершает все сессии сразу. ' +
          'Права, доступ и блокировку себе не меняют (409 staff.self).',
        params: PI,
        body: z.object({
          fullName: z.string().trim().min(3).max(120).optional(),
          phone: z.string().trim().max(40).nullable().optional(),
          ...PositionInput,
          applyPositionRights: z.boolean().optional(),
          access: z.enum(['staff', 'admin']).optional(),
          rights: RightsDto.optional(),
          requireTotp: z.boolean().optional(),
          isActive: z.boolean().optional(),
        }),
        response: { 200: StaffDto },
      },
      config: { permission: 'staff.manage' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const body = req.body;
      await db.transaction(async (tx) => {
        const row = await one(tx, ctx.propertyId, req.params.id);
        if (row.u.archivedAt) throw conflict('staff.archived', 'Сотрудник уволен', 'Сначала верните его на работу.');
        const touchesAccess = body.access !== undefined || body.rights !== undefined || body.isActive !== undefined || body.requireTotp !== undefined || body.applyPositionRights;
        assertManageable(ctx, row, touchesAccess ? 'access' : 'edit');
        if (body.access === 'admin' && row.access !== 'admin' && ctx.access !== 'owner') throw forbidden('staff.admin', 'Администратора назначает владелец');

        const changes: Record<string, [unknown, unknown]> = {};
        const userSet: Partial<typeof users.$inferInsert> = {};
        if (body.fullName !== undefined && body.fullName !== row.u.fullName) {
          userSet.fullName = body.fullName;
          changes.fullName = [row.u.fullName, body.fullName];
        }
        if (body.phone !== undefined && (body.phone || null) !== row.u.phone) {
          userSet.phone = body.phone || null;
          changes.phone = [row.u.phone, body.phone || null];
        }
        if (body.isActive !== undefined && body.isActive !== row.u.isActive) {
          userSet.isActive = body.isActive;
          changes.isActive = [row.u.isActive, body.isActive];
        }
        if (body.requireTotp !== undefined && body.requireTotp !== row.u.totpRequired) {
          userSet.totpRequired = body.requireTotp;
          changes['Второй фактор'] = [row.u.totpRequired ? 'да' : 'нет', body.requireTotp ? 'да' : 'нет'];
        }

        const memberSet: Partial<typeof memberships.$inferInsert> = {};
        const beforeRights = cleanRights(row.rights);
        let rights = beforeRights;
        if (body.positionId !== undefined || body.positionName !== undefined) {
          const { row: position } = await resolvePosition(tx, ctx.orgId, body, body.rights ? cleanRights(body.rights) : beforeRights);
          if ((position?.id ?? null) !== row.positionId) {
            memberSet.positionId = position?.id ?? null;
            changes.position = [row.positionName, position?.name ?? null];
          }
          if (position && body.applyPositionRights) {
            rights = cleanRights(position.rights);
            if (position.requireTotp && !row.u.totpRequired && body.requireTotp === undefined) {
              userSet.totpRequired = true;
              changes['Второй фактор'] = ['нет', 'да'];
            }
          }
        }
        if (body.rights) rights = cleanRights(body.rights);
        const nextAccess = body.access ?? (row.access as Access);
        if (nextAccess !== row.access) {
          memberSet.access = nextAccess;
          changes.access = [ACCESS_LABELS[row.access as Access], ACCESS_LABELS[nextAccess]];
          if (nextAccess === 'admin' && body.requireTotp === undefined) userSet.totpRequired = true;
        }
        if (nextAccess === 'staff') {
          assertGrantable(ctx, row.access === 'staff' ? beforeRights : NO_RIGHTS, rights);
          const diff = rightsDiff(row.access === 'staff' ? beforeRights : NO_RIGHTS, rights);
          if (Object.keys(diff).length || row.access !== 'staff') {
            memberSet.rights = rights;
            Object.assign(changes, diff);
          }
        }

        if (Object.keys(userSet).length) {
          await tx.update(users).set({ ...userSet, updatedAt: new Date(), version: row.u.version + 1 }).where(eq(users.id, row.u.id));
        }
        if (Object.keys(memberSet).length) {
          await tx.update(memberships).set(memberSet).where(and(eq(memberships.userId, row.u.id), eq(memberships.propertyId, ctx.propertyId)));
        }
        if (body.isActive === false) {
          await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, row.u.id), isNull(sessions.revokedAt)));
        }
        if (Object.keys(changes).length) {
          const onlyRights = Object.keys(changes).every((k) => !['fullName', 'phone', 'isActive', 'position', 'access'].includes(k));
          await audit(tx, ctx, {
            action: body.isActive === false ? 'staff.block' : body.isActive === true ? 'staff.unblock' : onlyRights ? 'staff.rights' : 'staff.update',
            entityType: 'user',
            entityId: row.u.id,
            entityLabel: row.u.fullName,
            changes,
          });
        }
      });
      return dto(db, ctx.propertyId, await one(db, ctx.propertyId, req.params.id));
    },
  );

  app.post(
    '/staff/:id/password',
    {
      schema: {
        tags: ['Персонал'],
        summary: 'Сбросить пароль: выдаётся временный',
        description: 'Все сессии сотрудника завершаются. Временный пароль в ответе один раз; при входе сотрудник задаёт свой.',
        params: PI,
        response: { 200: z.object({ temporaryPassword: z.string() }) },
      },
      config: { permission: 'staff.manage' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const password = temporaryPassword();
      await db.transaction(async (tx) => {
        const row = await one(tx, ctx.propertyId, req.params.id);
        assertManageable(ctx, row, 'access');
        if (row.u.archivedAt) throw conflict('staff.archived', 'Сотрудник уволен', 'Сначала верните его на работу.');
        await tx
          .update(users)
          .set({ passwordHash: await hashSecret(password), mustChangePassword: true, passwordChangedAt: new Date(), updatedAt: new Date() })
          .where(eq(users.id, row.u.id));
        await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, row.u.id), isNull(sessions.revokedAt)));
        await audit(tx, ctx, { action: 'staff.password_reset', entityType: 'user', entityId: row.u.id, entityLabel: row.u.fullName });
      });
      return { temporaryPassword: password };
    },
  );

  app.post(
    '/staff/:id/pin',
    {
      schema: {
        tags: ['Персонал'],
        summary: 'Новый PIN для планшета прихода',
        description: 'Без тела - PIN придумывает система и отдаёт один раз.',
        params: PI,
        body: z.object({ pin: z.string().regex(/^\d{4,6}$/, 'PIN - от 4 до 6 цифр').optional() }).default({}),
        response: { 200: z.object({ pin: z.string() }) },
      },
      config: { permission: 'staff.manage' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const pin = req.body.pin ?? randomPin();
      await db.transaction(async (tx) => {
        const row = await one(tx, ctx.propertyId, req.params.id);
        assertManageable(ctx, row, 'edit');
        await tx.update(users).set({ pinHash: await hashSecret(pin), updatedAt: new Date() }).where(eq(users.id, row.u.id));
        await audit(tx, ctx, { action: 'staff.pin_reset', entityType: 'user', entityId: row.u.id, entityLabel: row.u.fullName });
      });
      return { pin };
    },
  );

  app.post(
    '/staff/:id/sessions/end',
    {
      schema: { tags: ['Персонал'], summary: 'Завершить все сеансы сотрудника', description: 'Пароль остаётся прежним.', params: PI, response: { 204: z.undefined() } },
      config: { permission: 'staff.manage' },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      await db.transaction(async (tx) => {
        const row = await one(tx, ctx.propertyId, req.params.id);
        assertManageable(ctx, row, 'edit');
        await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, row.u.id), isNull(sessions.revokedAt)));
        await audit(tx, ctx, { action: 'staff.sessions_end', entityType: 'user', entityId: row.u.id, entityLabel: row.u.fullName });
      });
      return reply.status(204).send();
    },
  );

  app.delete(
    '/staff/:id',
    {
      schema: {
        tags: ['Персонал'],
        summary: 'Уволить: вход закрывается, сотрудник уходит из списков',
        description: 'Имя остаётся в бронях, сменах и журнале. Вернуть - POST /staff/:id/restore.',
        params: PI,
        body: z.object({ reason: z.string().trim().max(300).optional() }).default({}),
        response: { 204: z.undefined() },
      },
      config: { permission: 'staff.manage' },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      await db.transaction(async (tx) => {
        const row = await one(tx, ctx.propertyId, req.params.id);
        assertManageable(ctx, row, 'access');
        if (row.u.archivedAt) return;
        await tx.update(users).set({ archivedAt: new Date(), isActive: false, updatedAt: new Date(), version: row.u.version + 1 }).where(eq(users.id, row.u.id));
        await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, row.u.id), isNull(sessions.revokedAt)));
        await audit(tx, ctx, { action: 'staff.archive', entityType: 'user', entityId: row.u.id, entityLabel: row.u.fullName, ...(req.body.reason ? { reason: req.body.reason } : {}) });
      });
      return reply.status(204).send();
    },
  );

  app.post(
    '/staff/:id/restore',
    {
      schema: {
        tags: ['Персонал'],
        summary: 'Вернуть уволенного сотрудника',
        description: 'Вход открывается с новым временным паролем - он в ответе один раз. Права прежние.',
        params: PI,
        response: { 200: z.object({ employee: StaffDto, secrets: Secrets }) },
      },
      config: { permission: 'staff.manage' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const password = temporaryPassword();
      await db.transaction(async (tx) => {
        const row = await one(tx, ctx.propertyId, req.params.id);
        assertManageable(ctx, row, 'access');
        if (!row.u.archivedAt) throw conflict('staff.not_archived', 'Сотрудник и так работает');
        assertGrantable(ctx, NO_RIGHTS, cleanRights(row.rights));
        await tx
          .update(users)
          .set({ archivedAt: null, isActive: true, passwordHash: await hashSecret(password), mustChangePassword: true, updatedAt: new Date(), version: row.u.version + 1 })
          .where(eq(users.id, row.u.id));
        await audit(tx, ctx, { action: 'staff.restore', entityType: 'user', entityId: row.u.id, entityLabel: row.u.fullName });
      });
      const employee = await dto(db, ctx.propertyId, await one(db, ctx.propertyId, req.params.id));
      return { employee, secrets: { temporaryPassword: password, pin: null } };
    },
  );
};
