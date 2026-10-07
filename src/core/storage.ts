import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { TokenService } from '../lib/tokens.ts';

export type UploadTarget = { method: 'PUT'; url: string; headers: Record<string, string>; expiresAt: string };

/**
 * Хранилище файлов. Клиент получает подписанную ссылку и кладёт байты сам,
 * мимо бизнес-логики API. Сейчас - локальный диск; драйвер S3 (presigned PUT)
 * реализует тот же интерфейс, и клиентам ничего менять не придётся.
 */
export interface FileStorage {
  readonly driver: string;
  uploadTarget(fileId: string, contentType: string, expiresAt: Date): UploadTarget;
  downloadUrl(fileId: string, expiresAt: Date): string;
  /** Только для локального драйвера: приём байтов по подписанной ссылке. */
  write(storageKey: string, body: Readable, maxBytes: number): Promise<number>;
  read(storageKey: string): Promise<{ stream: Readable; size: number }>;
}

export class LocalFileStorage implements FileStorage {
  readonly driver = 'local';
  private readonly baseDir: string;
  private readonly publicApiUrl: string;
  private readonly tokens: TokenService;

  constructor(baseDir: string, publicApiUrl: string, tokens: TokenService) {
    this.baseDir = baseDir;
    this.publicApiUrl = publicApiUrl;
    this.tokens = tokens;
  }

  uploadTarget(fileId: string, contentType: string, expiresAt: Date): UploadTarget {
    const token = this.tokens.signUrl(`put:${fileId}`, expiresAt);
    return {
      method: 'PUT',
      url: `${this.publicApiUrl}/api/v1/files/${fileId}/content?token=${encodeURIComponent(token)}`,
      headers: { 'Content-Type': contentType },
      expiresAt: expiresAt.toISOString(),
    };
  }

  downloadUrl(fileId: string, expiresAt: Date): string {
    const token = this.tokens.signUrl(`get:${fileId}`, expiresAt);
    return `${this.publicApiUrl}/api/v1/files/${fileId}/content?token=${encodeURIComponent(token)}`;
  }

  private resolve(storageKey: string): string {
    const full = path.resolve(this.baseDir, storageKey);
    if (!full.startsWith(path.resolve(this.baseDir))) throw new Error('Недопустимый путь файла');
    return full;
  }

  async write(storageKey: string, body: Readable, maxBytes: number): Promise<number> {
    const full = this.resolve(storageKey);
    await mkdir(path.dirname(full), { recursive: true });
    let written = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.length;
        if (written > maxBytes) cb(new Error('Файл больше разрешённого размера'));
        else cb(null, chunk);
      },
    });
    await pipeline(body, limiter, createWriteStream(full));
    return written;
  }

  async read(storageKey: string): Promise<{ stream: Readable; size: number }> {
    const full = this.resolve(storageKey);
    const info = await stat(full);
    return { stream: createReadStream(full), size: info.size };
  }
}
