import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { PropertyContext } from '../../core/context.ts';
import { ctxOf } from '../../core/guards.ts';
import type { Permission } from '../../lib/access.ts';

const P = z.object({ propertyId: z.uuid() });

/** Кто какие события получает: горничная не узнает о деньгах из потока событий. */
const TOPIC_ACCESS: [prefix: string, any: Permission[]][] = [
  ['booking.', ['tape.view', 'booking.view']],
  ['room.', ['tape.view', 'hk.view', 'hk.own_tasks']],
  ['hk.task.', ['hk.view', 'hk.own_tasks']],
  ['payment.', ['cash.view']],
  ['shift.', ['cash.view']],
  ['maintenance.', ['maintenance.view', 'maintenance.create']],
  ['guest.', ['guest.view']],
  ['attendance.', ['attendance.view', 'cash.shift']],
];

function acceptsFor(ctx: PropertyContext) {
  return (topic: string) => {
    const rule = TOPIC_ACCESS.find(([prefix]) => topic.startsWith(prefix));
    return !!rule && rule[1].some((p) => ctx.permissions.has(p));
  };
}

export const eventRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/events',
    {
      schema: {
        tags: ['События'],
        summary: 'Поток изменений (Server-Sent Events)',
        description:
          'Каждое событие: event=<тема>, data={topic, entityId}. Клиент по нему перечитывает нужные данные. ' +
          'Мобильные приложения получат те же события через push.',
        params: P,
      },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      reply.hijack();
      const res = reply.raw;
      const origin = req.headers.origin;
      const headers: Record<string, string> = {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      };
      if (origin && app.deps.config.CORS_ORIGINS.split(',').map((s) => s.trim()).includes(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Access-Control-Allow-Credentials'] = 'true';
        headers.Vary = 'Origin';
      }
      res.writeHead(200, headers);
      res.write(`retry: 3000\n: connected\n\n`);
      const unsubscribe = app.deps.events.subscribe({
        propertyId: ctx.propertyId,
        accepts: acceptsFor(ctx),
        send: (e) => {
          res.write(`id: ${e.id}\nevent: ${e.topic}\ndata: ${JSON.stringify({ topic: e.topic, entityId: e.entityId })}\n\n`);
        },
      });
      const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
      req.raw.on('close', () => {
        clearInterval(ping);
        unsubscribe();
      });
    },
  );
};
