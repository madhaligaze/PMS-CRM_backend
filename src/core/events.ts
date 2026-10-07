import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';

export type HubEvent = { id: number; propertyId: string; topic: string; entityId: string | null };

type Subscriber = {
  propertyId: string;
  accepts: (topic: string) => boolean;
  send: (event: HubEvent) => void;
};

/**
 * Раздача событий outbox подключённым клиентам. Источник - LISTEN на канале
 * outbox: уведомление приходит только после коммита транзакции, поэтому
 * клиент не увидит событие об изменении, которого в базе нет.
 */
export class EventHub {
  private readonly subscribers = new Set<Subscriber>();
  private unlisten: (() => Promise<void>) | null = null;
  private readonly sql: postgres.Sql;
  private readonly log: FastifyBaseLogger;

  constructor(sql: postgres.Sql, log: FastifyBaseLogger) {
    this.sql = sql;
    this.log = log;
  }

  async start(): Promise<void> {
    const { unlisten } = await this.sql.listen('outbox', (payload) => {
      try {
        this.dispatch(JSON.parse(payload) as HubEvent);
      } catch (err) {
        this.log.warn({ err }, 'не удалось разобрать событие outbox');
      }
    });
    this.unlisten = unlisten;
  }

  async stop(): Promise<void> {
    await this.unlisten?.();
    this.unlisten = null;
  }

  subscribe(sub: Subscriber): () => void {
    this.subscribers.add(sub);
    return () => {
      this.subscribers.delete(sub);
    };
  }

  get size(): number {
    return this.subscribers.size;
  }

  private dispatch(event: HubEvent): void {
    for (const sub of this.subscribers) {
      if (sub.propertyId === event.propertyId && sub.accepts(event.topic)) sub.send(event);
    }
  }
}
