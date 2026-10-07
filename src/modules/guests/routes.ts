import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../core/audit.ts';
import { ctxOf } from '../../core/guards.ts';
import { expectedVersion, setEtag } from '../../core/http.ts';
import { companies, files, guestDocuments, guests, users } from '../../db/schema/index.ts';
import { addDays, localDate } from '../../lib/dates.ts';
import { conflict, notFound, preconditionFailed } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { fullName } from '../../lib/normalize.ts';
import { decodeCursor, PageQuery, pageOf, pageSchema } from '../../lib/pagination.ts';
import {
  CompanyDto,
  CompanyInput,
  GuestDocumentDto,
  GuestDto,
  GuestInput,
  GuestListItemDto,
  GuestMatchDto,
  StayDto,
} from './schemas.ts';
import * as svc from './service.ts';

const P = z.object({ propertyId: z.uuid() });
const PI = P.extend({ id: z.uuid() });

export const guestRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = app.deps.db;

  app.get(
    '/guests',
    {
      schema: {
        tags: ['Гости'],
        summary: 'База гостей: поиск по ФИО, телефону, номеру документа',
        params: P,
        querystring: PageQuery.extend({
          q: z.string().max(100).optional(),
          filter: z.enum(['vip', 'blacklisted', 'regular', 'corporate']).optional(),
        }),
        response: { 200: pageSchema(GuestListItemDto) },
      },
      config: { permission: 'guest.view' },
    },
    async (req) => svc.listGuests(db, ctxOf(req), req.query),
  );

  app.post(
    '/guests',
    {
      schema: {
        tags: ['Гости'],
        summary: 'Новая карточка гостя',
        description: 'Если гость с таким документом уже есть, ответ 409 code=guest.duplicate с guestId найденной карточки.',
        params: P,
        body: GuestInput,
        response: { 201: GuestDto },
      },
      config: { permission: 'guest.edit', idempotent: true },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      const dto = await db.transaction(async (tx) => {
        const g = await svc.createGuest(tx, ctx, req.body);
        return svc.getGuest(tx, ctx, g.id);
      });
      setEtag(reply, dto.version);
      return reply.status(201).send(dto);
    },
  );

  app.post(
    '/guests/match',
    {
      schema: {
        tags: ['Гости'],
        summary: 'Поиск возможных дублей',
        description: 'Совпадение документа - тот же человек. Телефон или ФИО с датой рождения - возможно тот же.',
        params: P,
        body: z.object({
          docNumber: z.string().max(40).nullable().optional(),
          citizenship: z.string().max(3).nullable().optional(),
          phone: z.string().max(40).nullable().optional(),
          lastName: z.string().max(80).nullable().optional(),
          firstName: z.string().max(80).nullable().optional(),
          birthDate: z.iso.date().nullable().optional(),
          excludeId: z.uuid().optional(),
        }),
        response: { 200: z.array(GuestMatchDto) },
      },
      config: { permission: 'guest.view' },
    },
    async (req) => svc.matchGuests(db, ctxOf(req), req.body),
  );

  app.get(
    '/guests/:id',
    { schema: { tags: ['Гости'], summary: 'Карточка гостя', params: PI, response: { 200: GuestDto } }, config: { permission: 'guest.view' } },
    async (req, reply) => {
      const dto = await svc.getGuest(db, ctxOf(req), req.params.id);
      setEtag(reply, dto.version);
      return dto;
    },
  );

  app.patch(
    '/guests/:id',
    {
      schema: {
        tags: ['Гости'],
        summary: 'Изменить карточку гостя',
        description: 'Нужен If-Match с версией карточки. Чёрный список - только с правом и причиной.',
        params: PI,
        body: GuestInput.partial().extend({
          blacklisted: z.boolean().optional(),
          blacklistReason: z.string().max(500).nullable().optional(),
          version: z.number().int().optional(),
        }),
        response: { 200: GuestDto },
      },
      config: { permission: 'guest.edit' },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      const version = expectedVersion(req, req.body.version);
      const { version: _v, ...input } = req.body;
      const dto = await db.transaction(async (tx) => {
        await svc.updateGuest(tx, ctx, req.params.id, input, version);
        return svc.getGuest(tx, ctx, req.params.id);
      });
      setEtag(reply, dto.version);
      return dto;
    },
  );

  app.post(
    '/guests/:id/merge',
    {
      schema: {
        tags: ['Гости'],
        summary: 'Объединить дубль с этой карточкой',
        params: PI,
        body: z.object({ duplicateId: z.uuid() }),
        response: { 200: GuestDto },
      },
      config: { permission: 'guest.merge' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      return db.transaction(async (tx) => {
        await svc.mergeGuests(tx, ctx, req.params.id, req.body.duplicateId);
        return svc.getGuest(tx, ctx, req.params.id);
      });
    },
  );

  app.post(
    '/guests/:id/consent',
    {
      schema: {
        tags: ['Гости'],
        summary: 'Гость подписал согласие на обработку персональных данных и правила проживания',
        params: PI,
        body: z.object({ method: z.enum(['paper', 'tablet']) }),
        response: { 200: GuestDto },
      },
      config: { permission: 'guest.edit' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      return db.transaction(async (tx) => {
        await svc.recordConsent(tx, ctx, req.params.id, req.body.method);
        return svc.getGuest(tx, ctx, req.params.id);
      });
    },
  );

  app.get(
    '/guests/:id/stays',
    { schema: { tags: ['Гости'], summary: 'История: проживания, отмены, незаезды', params: PI, response: { 200: z.array(StayDto) } }, config: { permission: 'guest.view' } },
    async (req) => svc.guestStays(db, ctxOf(req), req.params.id),
  );

  // ── Сканы документов ─────────────────────────────────────────────────────
  app.get(
    '/guests/:id/documents',
    {
      schema: { tags: ['Гости'], summary: 'Сканы документов гостя', params: PI, response: { 200: z.array(GuestDocumentDto) } },
      config: { permission: 'guest.documents' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      await svc.loadGuest(db, ctx, req.params.id);
      const rows = await db
        .select({ d: guestDocuments, f: files, by: users.fullName })
        .from(guestDocuments)
        .innerJoin(files, eq(files.id, guestDocuments.fileId))
        .leftJoin(users, eq(users.id, guestDocuments.uploadedBy))
        .where(eq(guestDocuments.guestId, req.params.id))
        .orderBy(desc(guestDocuments.uploadedAt));
      return rows.map((r) => ({
        id: r.d.id,
        kind: r.d.kind,
        fileId: r.f.id,
        contentType: r.f.contentType,
        size: r.f.size,
        uploadedAt: r.d.uploadedAt.toISOString(),
        uploadedBy: r.by,
        retainUntil: r.d.retainUntil,
      }));
    },
  );

  app.post(
    '/guests/:id/documents',
    {
      schema: {
        tags: ['Гости'],
        summary: 'Прикрепить загруженный скан к гостю',
        params: PI,
        body: z.object({ fileId: z.uuid(), kind: z.enum(['passport', 'id_front', 'id_back', 'other']) }),
        response: { 201: GuestDocumentDto },
      },
      config: { permission: 'guest.documents' },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      const dto = await db.transaction(async (tx) => {
        const g = await svc.loadGuest(tx, ctx, req.params.id);
        const [file] = await tx.select().from(files).where(and(eq(files.id, req.body.fileId), eq(files.orgId, ctx.orgId)));
        if (!file) throw notFound('file.not_found', 'Файл не найден');
        if (file.status !== 'ready') throw conflict('file.not_uploaded', 'Файл ещё не загружен');
        if (file.purpose !== 'guest_document') throw conflict('file.purpose', 'Файл загружен не как скан документа');
        const retainUntil = addDays(localDate(new Date(), ctx.property.timezone), ctx.property.settings.scanRetentionDays);
        const [row] = await tx
          .insert(guestDocuments)
          .values({ id: newId(), orgId: ctx.orgId, guestId: g.id, fileId: file.id, kind: req.body.kind, retainUntil, uploadedBy: ctx.actor.id })
          .returning();
        await audit(tx, ctx, {
          action: 'guest.document.add',
          entityType: 'guest',
          entityId: g.id,
          entityLabel: fullName(g),
          changes: { document: [null, req.body.kind] },
        });
        return {
          id: row!.id,
          kind: row!.kind,
          fileId: file.id,
          contentType: file.contentType,
          size: file.size,
          uploadedAt: row!.uploadedAt.toISOString(),
          uploadedBy: ctx.actor.name,
          retainUntil,
        };
      });
      return reply.status(201).send(dto);
    },
  );

  app.get(
    '/guests/:id/documents/:documentId/url',
    {
      schema: {
        tags: ['Гости'],
        summary: 'Ссылка на скан на 2 минуты',
        description: 'Каждый просмотр скана записывается в журнал: кто и когда открыл документ гостя.',
        params: PI.extend({ documentId: z.uuid() }),
        response: { 200: z.object({ url: z.string(), expiresAt: z.iso.datetime() }) },
      },
      config: { permission: 'guest.documents' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const g = await svc.loadGuest(db, ctx, req.params.id);
      const [doc] = await db
        .select()
        .from(guestDocuments)
        .where(and(eq(guestDocuments.id, req.params.documentId), eq(guestDocuments.guestId, g.id)));
      if (!doc) throw notFound('document.not_found', 'Скан не найден');
      const expiresAt = new Date(Date.now() + 120_000);
      await audit(db, ctx, {
        action: 'guest.document.view',
        entityType: 'guest',
        entityId: g.id,
        entityLabel: fullName(g),
        changes: { document: [null, doc.kind] },
      });
      return { url: app.deps.storage.downloadUrl(doc.fileId, expiresAt), expiresAt: expiresAt.toISOString() };
    },
  );

  // ── Компании ─────────────────────────────────────────────────────────────
  const companyCounts = sql<number>`(select count(*) from guests g where g.company_id = ${companies.id} and g.merged_into is null)::int`;
  const companyBookings = sql<number>`(select count(*) from bookings b where b.company_id = ${companies.id})::int`;

  app.get(
    '/companies',
    {
      schema: {
        tags: ['Компании'],
        summary: 'Компании-клиенты',
        params: P,
        querystring: PageQuery.extend({ q: z.string().max(100).optional() }),
        response: { 200: pageSchema(CompanyDto) },
      },
      config: { permission: 'company.view' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const conds: SQL[] = [eq(companies.orgId, ctx.orgId)];
      if (req.query.q?.trim()) conds.push(sql`lower(${companies.name}) like ${'%' + req.query.q.trim().toLowerCase() + '%'}`);
      const cursor = decodeCursor<[string, string]>(req.query.cursor);
      if (cursor) conds.push(sql`(${companies.name}, ${companies.id}) > (${cursor[0]}, ${cursor[1]})`);
      const rows = await db
        .select({ c: companies, guests: companyCounts, bookings: companyBookings })
        .from(companies)
        .where(and(...conds))
        .orderBy(asc(companies.name), asc(companies.id))
        .limit(req.query.limit + 1);
      const page = pageOf(rows, req.query.limit, (r) => [r.c.name, r.c.id]);
      return {
        items: page.items.map((r) => ({ ...companyDto(r.c), guests: r.guests, bookings: r.bookings })),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.post(
    '/companies',
    {
      schema: { tags: ['Компании'], summary: 'Новая компания', params: P, body: CompanyInput, response: { 201: CompanyDto } },
      config: { permission: 'company.edit', idempotent: true },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      const row = await db.transaction(async (tx) => {
        const [c] = await tx.insert(companies).values({ id: newId(), orgId: ctx.orgId, ...req.body }).returning();
        await audit(tx, ctx, { action: 'company.create', entityType: 'company', entityId: c!.id, entityLabel: c!.name, after: req.body });
        return c!;
      });
      return reply.status(201).send({ ...companyDto(row), guests: 0, bookings: 0 });
    },
  );

  app.get(
    '/companies/:id',
    { schema: { tags: ['Компании'], summary: 'Компания', params: PI, response: { 200: CompanyDto } }, config: { permission: 'company.view' } },
    async (req) => {
      const ctx = ctxOf(req);
      const [r] = await db
        .select({ c: companies, guests: companyCounts, bookings: companyBookings })
        .from(companies)
        .where(and(eq(companies.id, req.params.id), eq(companies.orgId, ctx.orgId)));
      if (!r) throw notFound('company.not_found', 'Компания не найдена');
      return { ...companyDto(r.c), guests: r.guests, bookings: r.bookings };
    },
  );

  app.patch(
    '/companies/:id',
    {
      schema: {
        tags: ['Компании'],
        summary: 'Изменить компанию',
        params: PI,
        body: CompanyInput.partial().extend({ version: z.number().int().optional() }),
        response: { 200: CompanyDto },
      },
      config: { permission: 'company.edit' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const version = expectedVersion(req, req.body.version);
      const { version: _v, ...patch } = req.body;
      return db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(companies)
          .where(and(eq(companies.id, req.params.id), eq(companies.orgId, ctx.orgId)))
          .for('update');
        if (!before) throw notFound('company.not_found', 'Компания не найдена');
        if (before.version !== version) throw preconditionFailed('Компанию уже изменил другой сотрудник', undefined, { currentVersion: before.version });
        const [after] = await tx
          .update(companies)
          .set({ ...patch, updatedAt: new Date(), version: before.version + 1 })
          .where(eq(companies.id, before.id))
          .returning();
        await audit(tx, ctx, { action: 'company.update', entityType: 'company', entityId: before.id, entityLabel: after!.name, before, after: after! });
        const [counts] = await tx
          .select({ guests: companyCounts, bookings: companyBookings })
          .from(companies)
          .where(eq(companies.id, before.id));
        return { ...companyDto(after!), guests: counts!.guests, bookings: counts!.bookings };
      });
    },
  );

  app.get(
    '/companies/:id/guests',
    {
      schema: { tags: ['Компании'], summary: 'Сотрудники компании в базе гостей', params: PI, response: { 200: z.array(GuestListItemDto) } },
      config: { permission: ['company.view', 'guest.view'] },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const rows = await db
        .select()
        .from(guests)
        .where(and(eq(guests.companyId, req.params.id), eq(guests.orgId, ctx.orgId), sql`${guests.mergedInto} is null`))
        .orderBy(asc(guests.lastName));
      const stats = await svc.guestStats(db, rows.map((r) => r.id));
      const [c] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, req.params.id));
      return rows.map((g) =>
        svc.listItemDto(g, stats.get(g.id) ?? { stays: 0, nights: 0, spent: 0, lastStay: null, cancellations: 0, noShows: 0 }, c?.name ?? null),
      );
    },
  );
};

function companyDto(c: typeof companies.$inferSelect) {
  return {
    id: c.id,
    name: c.name,
    taxId: c.taxId,
    legalAddress: c.legalAddress,
    phone: c.phone,
    email: c.email,
    contactName: c.contactName,
    notes: c.notes,
    version: c.version,
  };
}
