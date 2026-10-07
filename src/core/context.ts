import type { PropertySettings } from '../db/schema/index.ts';
import type { Access, Permission, Rights } from '../lib/access.ts';
import { forbidden } from '../lib/errors.ts';

/** Кто действует: сотрудник по токену или система (планировщик). */
export type Actor = { id: string | null; name: string };

/** Контекст запроса в пределах гостиницы: кто, где, с какими правами. */
export type PropertyContext = {
  orgId: string;
  propertyId: string;
  property: {
    name: string;
    timezone: string;
    currency: string;
    checkInTime: string;
    checkOutTime: string;
    settings: PropertySettings;
  };
  actor: Actor;
  /** Владелец, администратор или сотрудник; у системы - null. */
  access: Access | null;
  /** Права по разделам; у владельца и администратора - все. */
  rights: Rights;
  /** Внутренние права маршрутов, выведенные из доступа и прав (`lib/access.ts`). */
  permissions: ReadonlySet<Permission>;
  requestId: string | null;
  ip: string | null;
};

export function can(ctx: PropertyContext, permission: Permission): boolean {
  return ctx.permissions.has(permission);
}

export function requirePermission(ctx: PropertyContext, permission: Permission, detail?: string): void {
  if (!ctx.permissions.has(permission)) {
    throw forbidden('permission.denied', 'Недостаточно прав для этого действия', detail, { permission });
  }
}

export function requireAny(ctx: PropertyContext, permissions: Permission[], detail?: string): void {
  if (!permissions.some((p) => ctx.permissions.has(p))) {
    throw forbidden('permission.denied', 'Недостаточно прав для этого действия', detail, { permission: permissions });
  }
}
