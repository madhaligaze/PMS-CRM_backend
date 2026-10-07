import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { unauthorized } from './errors.ts';

export type AccessClaims = {
  /** id сотрудника */
  sub: string;
  /** id арендатора */
  org: string;
  /** id сессии: отзыв сессии гасит и её access-токены при следующей проверке */
  sid: string;
};

const ISSUER = 'bizdin-auyl';
const AUDIENCE = 'bizdin-auyl-api';

export class TokenService {
  private readonly key: Uint8Array;
  private readonly secret: string;
  readonly accessTtlSeconds: number;

  constructor(secret: string, accessTtlSeconds: number) {
    this.secret = secret;
    this.key = new TextEncoder().encode(secret);
    this.accessTtlSeconds = accessTtlSeconds;
  }

  async signAccess(claims: AccessClaims): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + this.accessTtlSeconds * 1000);
    const token = await new SignJWT({ org: claims.org, sid: claims.sid })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.key);
    return { token, expiresAt };
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: ISSUER, audience: AUDIENCE });
      if (typeof payload.sub !== 'string' || typeof payload.org !== 'string' || typeof payload.sid !== 'string') {
        throw unauthorized('auth.token_invalid', 'Неверный токен доступа');
      }
      return { sub: payload.sub, org: payload.org, sid: payload.sid };
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        throw unauthorized('auth.token_expired', 'Срок токена доступа истёк');
      }
      if (err instanceof Error && err.name === 'AppError') throw err;
      throw unauthorized('auth.token_invalid', 'Неверный токен доступа');
    }
  }

  /** Подпись короткоживущих ссылок на файлы: ссылка работает без заголовка Authorization. */
  signUrl(payload: string, expiresAt: Date): string {
    const exp = Math.floor(expiresAt.getTime() / 1000);
    const sig = createHmac('sha256', this.secret).update(`${payload}.${exp}`).digest('base64url');
    return `${exp}.${sig}`;
  }

  verifyUrl(payload: string, token: string): boolean {
    const [expStr, sig] = token.split('.');
    if (!expStr || !sig) return false;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
    const expected = createHmac('sha256', this.secret).update(`${payload}.${exp}`).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
