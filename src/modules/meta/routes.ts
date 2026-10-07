import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { unprocessable } from '../../lib/errors.ts';
import { parseMrz } from '../../lib/mrz.ts';

export const API_VERSION = '1.0.0';

const MetaDto = z
  .object({
    name: z.string(),
    apiVersion: z.string(),
    serverTime: z.iso.datetime(),
    minClientVersions: z.object({ ios: z.string(), android: z.string() }).describe('Ниже этих версий мобильное приложение просит обновиться'),
  })
  .meta({ id: 'Meta' });

export const MrzDto = z
  .object({
    format: z.enum(['TD1', 'TD2', 'TD3']),
    documentCode: z.string(),
    docType: z.enum(['passport', 'id_card', 'other']),
    issuingState: z.string(),
    documentNumber: z.string(),
    lastName: z.string(),
    firstName: z.string(),
    middleName: z.string().nullable(),
    nationality: z.string(),
    birthDate: z.iso.date().nullable(),
    sex: z.enum(['m', 'f']).nullable(),
    expiryDate: z.iso.date().nullable(),
    personalNumber: z.string().nullable(),
    checks: z.object({ documentNumber: z.boolean(), birthDate: z.boolean(), expiryDate: z.boolean(), composite: z.boolean().nullable() }),
    valid: z.boolean(),
  })
  .meta({ id: 'MrzResult' });

export const metaRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/meta',
    { schema: { tags: ['Служебное'], summary: 'Версия API и минимальные версии клиентов', security: [], response: { 200: MetaDto } } },
    async () => ({
      name: 'Bizdin Auyl API',
      apiVersion: API_VERSION,
      serverTime: new Date().toISOString(),
      minClientVersions: { ios: app.deps.config.MIN_CLIENT_VERSION_IOS, android: app.deps.config.MIN_CLIENT_VERSION_ANDROID },
    }),
  );
};

/** Разбор MRZ на сервере: веб, планшет и мобильное приложение получают одинаковый результат. */
export const documentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/documents/parse-mrz',
    {
      schema: {
        tags: ['Заселение'],
        summary: 'Разобрать машиночитаемую зону паспорта или ID-карты',
        description: 'Текст MRZ от сканера документов или OCR камеры. 422 - строки не похожи на MRZ.',
        params: z.object({ propertyId: z.uuid() }),
        body: z.object({ text: z.string().min(20).max(400) }),
        response: { 200: MrzDto },
      },
      config: { permission: 'guest.edit' },
    },
    async (req) => {
      const result = parseMrz(req.body.text);
      if (!result) {
        throw unprocessable(
          'mrz.unrecognized',
          'Не похоже на машиночитаемую зону документа',
          'Нужны две строки по 44 символа (паспорт) или три по 30 (ID-карта).',
        );
      }
      return result;
    },
  );
};
