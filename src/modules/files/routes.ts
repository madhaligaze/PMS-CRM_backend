import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAny } from '../../core/context.ts';
import { ctxOf } from '../../core/guards.ts';
import { files } from '../../db/schema/index.ts';
import { localDate } from '../../lib/dates.ts';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import type { Permission } from '../../lib/access.ts';

const P = z.object({ propertyId: z.uuid() });
const MAX_BYTES = 15 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'] as const;
const Purpose = z.enum(['guest_document', 'maintenance_photo', 'task_photo']).meta({ id: 'FilePurpose' });

const PURPOSE_ACCESS: Record<z.infer<typeof Purpose>, Permission[]> = {
  guest_document: ['guest.documents'],
  maintenance_photo: ['maintenance.create', 'maintenance.work'],
  task_photo: ['hk.own_tasks', 'hk.view'],
};

const UploadDto = z
  .object({
    fileId: z.uuid(),
    upload: z.object({ method: z.literal('PUT'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.iso.datetime() }),
  })
  .meta({ id: 'FileUpload' });

/** Создание файла и ссылка на выдачу: внутри гостиницы, с проверкой прав по назначению. */
export const fileRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = app.deps.db;

  app.post(
    '/files',
    {
      schema: {
        tags: ['Файлы'],
        summary: 'Начать загрузку файла: получить подписанную ссылку',
        description:
          'Клиент делает PUT на upload.url с телом файла и заголовками upload.headers. Ссылка живёт 10 минут. ' +
          'Сканы документов затем прикрепляются к гостю отдельным запросом.',
        params: P,
        body: z.object({ purpose: Purpose, contentType: z.enum(TYPES), size: z.number().int().min(1).max(MAX_BYTES) }),
        response: { 201: UploadDto },
      },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      requireAny(ctx, PURPOSE_ACCESS[req.body.purpose]);
      const id = newId();
      const day = localDate(new Date(), ctx.property.timezone);
      const storageKey = `${ctx.orgId}/${req.body.purpose}/${day.slice(0, 7)}/${id}`;
      await db.insert(files).values({
        id,
        orgId: ctx.orgId,
        propertyId: ctx.propertyId,
        purpose: req.body.purpose,
        storageKey,
        contentType: req.body.contentType,
        size: req.body.size,
        uploadedBy: ctx.actor.id,
      });
      const upload = app.deps.storage.uploadTarget(id, req.body.contentType, new Date(Date.now() + 10 * 60_000));
      return reply.status(201).send({ fileId: id, upload });
    },
  );

  app.get(
    '/files/:id/url',
    {
      schema: {
        tags: ['Файлы'],
        summary: 'Ссылка на фото ремонта или уборки',
        description: 'Сканы документов гостей выдаются только через карточку гостя: там просмотр пишется в журнал.',
        params: P.extend({ id: z.uuid() }),
        response: { 200: z.object({ url: z.string(), expiresAt: z.iso.datetime() }) },
      },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const [f] = await db.select().from(files).where(and(eq(files.id, req.params.id), eq(files.orgId, ctx.orgId)));
      if (!f) throw notFound('file.not_found', 'Файл не найден');
      if (f.purpose === 'guest_document') throw forbidden('file.via_guest', 'Скан документа открывается из карточки гостя');
      requireAny(ctx, [...PURPOSE_ACCESS[f.purpose], 'maintenance.view']);
      const expiresAt = new Date(Date.now() + 5 * 60_000);
      return { url: app.deps.storage.downloadUrl(f.id, expiresAt), expiresAt: expiresAt.toISOString() };
    },
  );
};

/** Приём и выдача байтов по подписанной ссылке: без заголовка Authorization. */
export const fileContentRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = app.deps.db;

  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf', 'application/octet-stream'], (_req, payload, done) => {
    done(null, payload);
  });

  app.put(
    '/files/:id/content',
    {
      schema: {
        tags: ['Файлы'],
        summary: 'Загрузка байтов файла по подписанной ссылке',
        security: [],
        params: z.object({ id: z.uuid() }),
        querystring: z.object({ token: z.string() }),
      },
      bodyLimit: MAX_BYTES + 1024,
    },
    async (req, reply) => {
      if (!app.deps.tokens.verifyUrl(`put:${req.params.id}`, req.query.token)) throw forbidden('file.link_invalid', 'Ссылка недействительна или истекла');
      const [f] = await db.select().from(files).where(eq(files.id, req.params.id));
      if (!f) throw notFound('file.not_found', 'Файл не найден');
      if (f.status === 'ready') throw conflict('file.already_uploaded', 'Файл уже загружен');
      const ct = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
      if (ct !== f.contentType) throw badRequest('file.type_mismatch', 'Тип файла не совпадает с заявленным');
      const written = await app.deps.storage.write(f.storageKey, req.body as NodeJS.ReadableStream as never, MAX_BYTES);
      await db.update(files).set({ status: 'ready', size: written }).where(eq(files.id, f.id));
      return reply.status(204).send();
    },
  );

  app.get(
    '/files/:id/content',
    {
      schema: {
        tags: ['Файлы'],
        summary: 'Скачать файл по подписанной ссылке',
        security: [],
        params: z.object({ id: z.uuid() }),
        querystring: z.object({ token: z.string() }),
      },
    },
    async (req, reply) => {
      if (!app.deps.tokens.verifyUrl(`get:${req.params.id}`, req.query.token)) throw forbidden('file.link_invalid', 'Ссылка недействительна или истекла');
      const [f] = await db.select().from(files).where(eq(files.id, req.params.id));
      if (!f || f.status !== 'ready') throw notFound('file.not_found', 'Файл не найден');
      const { stream, size } = await app.deps.storage.read(f.storageKey);
      return reply
        .header('Content-Type', f.contentType)
        .header('Content-Length', String(size))
        .header('Cache-Control', 'private, no-store')
        .header('Cross-Origin-Resource-Policy', 'cross-origin')
        .send(stream);
    },
  );
};
