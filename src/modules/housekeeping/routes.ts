import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ctxOf } from '../../core/guards.ts';
import { HkStatus } from '../property/routes.ts';
import * as svc from './service.ts';

const P = z.object({ propertyId: z.uuid() });
const PI = P.extend({ id: z.uuid() });

const TaskKind = z.enum(['departure', 'stayover', 'request', 'general']).meta({ id: 'HkTaskKind' });
const TaskStatus = z.enum(['open', 'in_progress', 'done', 'inspected', 'skipped', 'cancelled']).meta({ id: 'HkTaskStatus' });
const Checklist = z.array(z.object({ text: z.string().max(200), done: z.boolean() })).max(40);

export const HkTaskDto = z
  .object({
    id: z.uuid(),
    roomId: z.uuid(),
    roomNumber: z.string(),
    kind: TaskKind,
    status: TaskStatus,
    businessDate: z.iso.date(),
    assigneeId: z.uuid().nullable(),
    assigneeName: z.string().nullable(),
    dueAt: z.iso.datetime().nullable(),
    overdue: z.boolean().describe('Срок прошёл, задача не сделана: подсвечивается и уходит руководителю'),
    note: z.string().nullable(),
    checklist: Checklist,
    photoFileIds: z.array(z.uuid()),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    inspectedAt: z.iso.datetime().nullable(),
    inspectedBy: z.string().nullable(),
    skipReason: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    version: z.number().int(),
  })
  .meta({ id: 'HkTask' });

export const HkBoardDto = z
  .object({
    businessDate: z.iso.date(),
    rooms: z.array(
      z.object({
        id: z.uuid(),
        number: z.string(),
        roomTypeName: z.string(),
        floor: z.number().int().nullable(),
        hkStatus: HkStatus,
        hkStatusAt: z.iso.datetime(),
        dnd: z.boolean(),
        occupancy: z.enum(['free', 'occupied', 'arrival', 'departure', 'turnover', 'blocked']),
        arrivalGuest: z.string().nullable(),
        departureGuest: z.string().nullable(),
        inHouseGuest: z.string().nullable(),
        departureDone: z.boolean(),
        tasks: z.array(HkTaskDto),
      }),
    ),
    staff: z.array(z.object({ id: z.uuid(), name: z.string(), position: z.string().nullable() })),
  })
  .meta({ id: 'HkBoard' });

export const housekeepingRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = app.deps.db;

  app.get(
    '/housekeeping/board',
    {
      schema: {
        tags: ['Хозслужба'],
        summary: 'Доска номеров: занятость и состояние на сегодня',
        description: 'Имена гостей - только тем, кому положено видеть гостей. Горничной и технику - нет.',
        params: P,
        response: { 200: HkBoardDto },
      },
      config: { permission: ['hk.view', 'hk.own_tasks'] },
    },
    async (req) => svc.board(db, ctxOf(req)),
  );

  app.get(
    '/housekeeping/tasks',
    {
      schema: {
        tags: ['Хозслужба'],
        summary: 'Задачи уборки',
        description: 'updatedSince - всё, что изменилось с момента X: для мобильного приложения с офлайн-режимом.',
        params: P,
        querystring: z.object({
          date: z.iso.date().optional(),
          assignee: z.string().optional(),
          status: z
            .union([TaskStatus, z.array(TaskStatus)])
            .optional()
            .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
          updatedSince: z.iso.datetime({ offset: true }).optional(),
        }),
        response: { 200: z.array(HkTaskDto) },
      },
      config: { permission: ['hk.view', 'hk.own_tasks'] },
    },
    async (req) => svc.listTasks(db, ctxOf(req), req.query),
  );

  app.post(
    '/housekeeping/tasks',
    {
      schema: {
        tags: ['Хозслужба'],
        summary: 'Задача уборки: по запросу гостя или генеральная',
        params: P,
        body: z.object({
          roomId: z.uuid(),
          kind: z.enum(['request', 'general', 'stayover', 'departure']).default('request'),
          note: z.string().trim().max(500).nullable().optional(),
          assigneeId: z.uuid().nullable().optional(),
          dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
        }),
        response: { 201: HkTaskDto },
      },
      config: { permission: ['hk.assign', 'hk.view'], idempotent: true },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      const id = await db.transaction((tx) => svc.createTask(tx, ctx, req.body));
      return reply.status(201).send(await svc.taskDto(db, id));
    },
  );

  app.patch(
    '/housekeeping/tasks/:id',
    {
      schema: {
        tags: ['Хозслужба'],
        summary: 'Назначить горничную, срок, примечание',
        params: PI,
        body: z.object({
          assigneeId: z.uuid().nullable().optional(),
          dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
          note: z.string().trim().max(500).nullable().optional(),
        }),
        response: { 200: HkTaskDto },
      },
      config: { permission: 'hk.assign' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      await db.transaction((tx) => svc.assignTask(tx, ctx, req.params.id, req.body));
      return svc.taskDto(db, req.params.id);
    },
  );

  app.post(
    '/housekeeping/tasks/:id/start',
    { schema: { tags: ['Хозслужба'], summary: 'Начать уборку', params: PI, response: { 200: HkTaskDto } }, config: { permission: ['hk.own_tasks', 'hk.assign'] } },
    async (req) => {
      const ctx = ctxOf(req);
      await db.transaction((tx) => svc.startTask(tx, ctx, req.params.id));
      return svc.taskDto(db, req.params.id);
    },
  );

  app.post(
    '/housekeeping/tasks/:id/finish',
    {
      schema: {
        tags: ['Хозслужба'],
        summary: 'Закончить уборку: номер «убран»',
        params: PI,
        body: z
          .object({ checklist: Checklist.optional(), photoFileIds: z.array(z.uuid()).max(10).optional(), note: z.string().trim().max(500).nullable().optional() })
          .default({}),
        response: { 200: HkTaskDto },
      },
      config: { permission: ['hk.own_tasks', 'hk.assign'] },
    },
    async (req) => {
      const ctx = ctxOf(req);
      await db.transaction((tx) => svc.finishTask(tx, ctx, req.params.id, req.body));
      return svc.taskDto(db, req.params.id);
    },
  );

  app.post(
    '/housekeeping/tasks/:id/inspect',
    {
      schema: {
        tags: ['Хозслужба'],
        summary: 'Принять номер («проверен») или вернуть на доуборку',
        params: PI,
        body: z.object({ ok: z.boolean(), note: z.string().trim().max(500).nullable().optional() }),
        response: { 200: HkTaskDto },
      },
      config: { permission: 'hk.inspect' },
    },
    async (req) => {
      const ctx = ctxOf(req);
      await db.transaction((tx) => svc.inspectTask(tx, ctx, req.params.id, req.body));
      return svc.taskDto(db, req.params.id);
    },
  );

  app.post(
    '/housekeeping/tasks/:id/skip',
    {
      schema: {
        tags: ['Хозслужба'],
        summary: 'Пропустить уборку: «не беспокоить», гость отказался или другая причина',
        description: 'Без причины пропустить задачу нельзя.',
        params: PI,
        body: z.object({ reason: z.enum(['dnd', 'refused', 'other']), note: z.string().trim().max(300).nullable().optional() }),
        response: { 200: HkTaskDto },
      },
      config: { permission: ['hk.own_tasks', 'hk.assign'] },
    },
    async (req) => {
      const ctx = ctxOf(req);
      await db.transaction((tx) => svc.skipTask(tx, ctx, req.params.id, req.body));
      return svc.taskDto(db, req.params.id);
    },
  );

  app.post(
    '/rooms/:id/hk-status',
    {
      schema: {
        tags: ['Хозслужба'],
        summary: 'Сменить состояние номера вручную',
        params: PI,
        body: z.object({ status: z.enum(['dirty', 'cleaning', 'clean', 'inspected']), note: z.string().trim().max(300).nullable().optional() }),
        response: { 204: z.undefined() },
      },
      config: { permission: 'hk.status' },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      await db.transaction((tx) => svc.changeRoomStatus(tx, ctx, req.params.id, req.body.status, req.body.note ?? null));
      return reply.status(204).send();
    },
  );

  app.post(
    '/rooms/:id/dnd',
    {
      schema: { tags: ['Хозслужба'], summary: '«Не беспокоить» на номере', params: PI, body: z.object({ on: z.boolean() }), response: { 204: z.undefined() } },
      config: { permission: ['hk.view', 'hk.own_tasks', 'booking.edit'] },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      await db.transaction((tx) => svc.setDnd(tx, ctx, req.params.id, req.body.on));
      return reply.status(204).send();
    },
  );
};
