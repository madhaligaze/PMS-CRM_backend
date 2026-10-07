/**
 * Доступ сотрудника к гостинице.
 *
 * Кто есть кто
 * ────────────
 * * Владелец - тот, кто зарегистрировал гостиницу. Один на организацию: видит
 *   и правит всё, управляет всеми; его учёткой управляет только он сам.
 * * Администратор - доверенное лицо владельца: видит и правит всё, заводит и
 *   увольняет сотрудников. Назначает и снимает администраторов только владелец.
 * * Сотрудник - то, что ему открыто: разделы по уровням и особые полномочия.
 *
 * Должность - не роль, а подпись и набор прав по умолчанию: при найме права
 * подставляются из должности, дальше живут у человека. Должности заводит
 * владелец сам, прямо в поле при найме, и список растёт вместе с гостиницей.
 *
 * Разделы и полномочия - словарь бизнеса гостиницы: о них думают, когда
 * нанимают человека («пусть заселяет, но кассу не закрывает»). Маршруты API
 * проверяют внутренние права помельче (`Permission`); они выводятся из
 * разделов только здесь, в `permissionsFor`.
 */

/** Внутренние права маршрутов. Человеку на экране не показываются. */
export const PERMISSIONS = [
  'dashboard.view',
  'tape.view',
  'booking.view',
  'booking.create',
  'booking.edit',
  'booking.confirm',
  'booking.cancel',
  'booking.checkin',
  'booking.checkout',
  'booking.checkout_debt',
  'booking.discount',
  'booking.discount.unlimited',
  'booking.special_price',
  'booking.special_price.approve',
  'block.manage',
  'guest.view',
  'guest.edit',
  'guest.documents',
  'guest.merge',
  'guest.blacklist',
  'company.view',
  'company.edit',
  'folio.view',
  'folio.charge',
  'folio.storno',
  'payment.accept',
  'payment.refund',
  'payment.refund.unlimited',
  'payment.storno',
  'payment.storno.closed',
  'cash.view',
  'cash.shift',
  'cash.reports',
  'hk.view',
  'hk.own_tasks',
  'hk.assign',
  'hk.inspect',
  'hk.status',
  'maintenance.create',
  'maintenance.view',
  'maintenance.work',
  'attendance.self',
  'attendance.view',
  'attendance.correct',
  'staff.view',
  'staff.manage',
  'rates.manage',
  'settings.manage',
  'reports.view',
  'reports.export',
  'audit.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Есть у каждого, кто работает в гостинице: отметить приход и сообщить о поломке. */
const ALWAYS: Permission[] = ['attendance.self', 'maintenance.create'];

export const ACCESS = ['owner', 'admin', 'staff'] as const;
export type Access = (typeof ACCESS)[number];

export const ACCESS_LABELS: Record<Access, string> = {
  owner: 'Владелец',
  admin: 'Администратор',
  staff: 'Сотрудник',
};

export const LEVELS = ['none', 'view', 'edit'] as const;
export type Level = (typeof LEVELS)[number];
const RANK: Record<Level, number> = { none: 0, view: 1, edit: 2 };
export const LEVEL_LABELS: Record<Level, string> = { none: 'Нет', view: 'Видит', edit: 'Правит' };

type SectionDef = {
  key: string;
  title: string;
  group: string;
  /** Какие уровни у раздела есть: у отчётов правки нет, у заселения - «смотреть» нечего. */
  levels: readonly Level[];
  /** Что значит «Правит» (или «Видит», если правки нет), - подпись под строкой. */
  hint: string;
  view: readonly Permission[];
  edit: readonly Permission[];
};

export const SECTIONS = [
  {
    key: 'bookings',
    title: 'Брони и шахматка',
    group: 'Продажи и ресепшен',
    levels: ['none', 'view', 'edit'],
    hint: 'Правит - создаёт, переносит, подтверждает и отменяет брони, даёт скидку в пределах лимита',
    view: ['dashboard.view', 'tape.view', 'booking.view'],
    edit: ['booking.create', 'booking.edit', 'booking.confirm', 'booking.cancel', 'booking.discount'],
  },
  {
    key: 'frontdesk',
    title: 'Заселение и выселение',
    group: 'Продажи и ресепшен',
    levels: ['none', 'edit'],
    hint: 'Заселяет и выселяет, вносит документ гостя, видит и загружает сканы документов',
    view: [],
    edit: ['dashboard.view', 'tape.view', 'booking.view', 'booking.checkin', 'booking.checkout', 'guest.view', 'guest.edit', 'guest.documents'],
  },
  {
    key: 'guests',
    title: 'Гости и компании',
    group: 'Продажи и ресепшен',
    levels: ['none', 'view', 'edit'],
    hint: 'Правит - заводит и меняет карточки гостей и компаний',
    view: ['guest.view', 'company.view'],
    edit: ['guest.edit', 'company.edit'],
  },
  {
    key: 'folio',
    title: 'Счёт гостя и оплаты',
    group: 'Деньги',
    levels: ['none', 'view', 'edit'],
    hint: 'Правит - принимает оплату и депозит, начисляет услуги, делает возврат в пределах лимита',
    view: ['folio.view'],
    edit: ['folio.charge', 'payment.accept', 'payment.refund'],
  },
  {
    key: 'cash',
    title: 'Касса и смены',
    group: 'Деньги',
    levels: ['none', 'view', 'edit'],
    hint: 'Видит - X- и Z-отчёты; правит - открывает и закрывает смену, выемка и внесение',
    view: ['cash.view', 'cash.reports'],
    edit: ['cash.shift'],
  },
  {
    key: 'housekeeping',
    title: 'Хозслужба',
    group: 'Номера',
    levels: ['none', 'view', 'edit'],
    hint: 'Правит - распределяет уборки, принимает номера, меняет их состояние',
    view: ['hk.view'],
    edit: ['hk.assign', 'hk.inspect', 'hk.status'],
  },
  {
    key: 'cleaning',
    title: 'Уборка номеров',
    group: 'Номера',
    levels: ['none', 'edit'],
    hint: 'Получает задачи уборки и отмечает их с телефона',
    view: [],
    edit: ['hk.own_tasks'],
  },
  {
    key: 'maintenance',
    title: 'Ремонт',
    group: 'Номера',
    levels: ['none', 'view', 'edit'],
    hint: 'Сообщить о поломке может каждый; правит - берёт заявки в работу и закрывает их',
    view: ['maintenance.view'],
    edit: ['maintenance.work'],
  },
  {
    key: 'attendance',
    title: 'Учёт времени',
    group: 'Персонал',
    levels: ['none', 'view', 'edit'],
    hint: 'Отметить свой приход может каждый; видит - табель всех; правит - исправляет отметки с причиной',
    view: ['attendance.view'],
    edit: ['attendance.correct'],
  },
  {
    key: 'staff',
    title: 'Сотрудники и права',
    group: 'Персонал',
    levels: ['none', 'view', 'edit'],
    hint: 'Правит - нанимает, меняет права не выше своих, блокирует и увольняет',
    view: ['staff.view'],
    edit: ['staff.manage'],
  },
  {
    key: 'reports',
    title: 'Отчёты',
    group: 'Управление',
    levels: ['none', 'view'],
    hint: 'Загрузка, ADR, RevPAR, выручка, источники; выгрузка в Excel',
    view: ['dashboard.view', 'reports.view', 'reports.export'],
    edit: [],
  },
  {
    key: 'settings',
    title: 'Номера, тарифы и настройки',
    group: 'Управление',
    levels: ['none', 'edit'],
    hint: 'Номерной фонд, цены, лимиты скидок и возвратов, причины отмен',
    view: [],
    edit: ['rates.manage', 'settings.manage'],
  },
  {
    key: 'audit',
    title: 'Журнал действий',
    group: 'Управление',
    levels: ['none', 'view'],
    hint: 'Кто, что и когда сделал в системе',
    view: ['audit.view'],
    edit: [],
  },
] as const satisfies readonly SectionDef[];

export type SectionKey = (typeof SECTIONS)[number]['key'];

export const POWERS = [
  { key: 'discount_unlimited', title: 'Скидка больше лимита', hint: 'Без полномочия скидка - не больше лимита из настроек', perms: ['booking.discount.unlimited'] },
  { key: 'special_price', title: 'Ставить спеццену', hint: 'Цена вне тарифа с основанием и тем, кто утвердил', perms: ['booking.special_price'] },
  { key: 'special_price_approve', title: 'Утверждать спеццену', hint: 'Его можно выбрать «кто утвердил»', perms: ['booking.special_price.approve'] },
  { key: 'refund_unlimited', title: 'Возврат больше лимита', hint: 'Без полномочия возврат - не больше лимита из настроек', perms: ['payment.refund.unlimited'] },
  { key: 'storno', title: 'Сторно в открытой смене', hint: 'Отменить ошибочную оплату или начисление с причиной', perms: ['payment.storno', 'folio.storno'] },
  { key: 'storno_closed', title: 'Сторно после Z-отчёта', hint: 'Исправить оплату из уже закрытой смены', perms: ['payment.storno.closed'] },
  { key: 'checkout_debt', title: 'Выселение с долгом компании', hint: 'Выпустить гостя, когда счёт оплатит компания позже', perms: ['booking.checkout_debt'] },
  { key: 'guest_admin', title: 'Чёрный список и объединение гостей', hint: 'Внести гостя в чёрный список, склеить карточки-дубли', perms: ['guest.merge', 'guest.blacklist'] },
  { key: 'block_rooms', title: 'Снимать номер с продажи', hint: 'Ремонт, авария, свой гость: номер не продаётся на эти даты', perms: ['block.manage'] },
] as const satisfies readonly { key: string; title: string; hint: string; perms: readonly Permission[] }[];

export type PowerKey = (typeof POWERS)[number]['key'];

/** Права человека: уровень по разделам и особые полномочия. Чего нет - того нет. */
export type Rights = {
  sections: Partial<Record<SectionKey, Level>>;
  powers: PowerKey[];
};

export const NO_RIGHTS: Rights = { sections: {}, powers: [] };

const SECTION_BY_KEY = new Map<string, (typeof SECTIONS)[number]>(SECTIONS.map((s) => [s.key, s]));
const POWER_BY_KEY = new Map<string, (typeof POWERS)[number]>(POWERS.map((p) => [p.key, p]));

/** Права из недоверенного ввода (тело запроса, jsonb): только известные разделы и уровни. */
export function cleanRights(raw: unknown): Rights {
  const out: Rights = { sections: {}, powers: [] };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as { sections?: unknown; powers?: unknown };
  if (r.sections && typeof r.sections === 'object') {
    for (const [key, level] of Object.entries(r.sections as Record<string, unknown>)) {
      const section = SECTION_BY_KEY.get(key);
      if (!section || typeof level !== 'string' || level === 'none') continue;
      if ((section.levels as readonly string[]).includes(level)) out.sections[key as SectionKey] = level as Level;
    }
  }
  if (Array.isArray(r.powers)) {
    for (const key of r.powers) if (typeof key === 'string' && POWER_BY_KEY.has(key) && !out.powers.includes(key as PowerKey)) out.powers.push(key as PowerKey);
  }
  out.powers.sort((a, b) => POWERS.findIndex((p) => p.key === a) - POWERS.findIndex((p) => p.key === b));
  return out;
}

/** Полный набор: всё, что вообще можно открыть. */
export function allRights(): Rights {
  return {
    sections: Object.fromEntries(SECTIONS.map((s) => [s.key, s.levels[s.levels.length - 1]])) as Rights['sections'],
    powers: POWERS.map((p) => p.key),
  };
}

export function levelOf(rights: Rights, section: SectionKey): Level {
  return rights.sections[section] ?? 'none';
}

/** Внутренние права маршрутов из доступа и прав человека. */
export function permissionsFor(access: Access, rights: Rights): Set<Permission> {
  if (access === 'owner' || access === 'admin') return new Set(PERMISSIONS);
  const out = new Set<Permission>(ALWAYS);
  for (const s of SECTIONS) {
    const level = levelOf(rights, s.key);
    if (level === 'none') continue;
    for (const p of s.view) out.add(p);
    if (level === 'edit') for (const p of s.edit) out.add(p);
  }
  for (const key of rights.powers) for (const p of POWER_BY_KEY.get(key)?.perms ?? []) out.add(p);
  return out;
}

/** Права, которые видит управляющий: у владельца и администратора - все. */
export function effectiveRights(access: Access, rights: Rights): Rights {
  return access === 'staff' ? rights : allRights();
}

/**
 * Не администратор раздаёт права не выше своих: иначе право «Сотрудники и
 * права» было бы правом «сделай себе помощника с любым доступом». Ответ -
 * текст отказа для человека или null.
 */
export function aboveOwn(granter: { access: Access; rights: Rights }, wanted: Rights): string | null {
  if (granter.access !== 'staff') return null;
  for (const s of SECTIONS) {
    const want = levelOf(wanted, s.key);
    const own = levelOf(granter.rights, s.key);
    if (RANK[want] > RANK[own]) return `${s.title}: выше ваших прав не открыть - у вас «${LEVEL_LABELS[own]}»`;
  }
  for (const key of wanted.powers) {
    if (!granter.rights.powers.includes(key)) return `${POWER_BY_KEY.get(key)!.title}: этого полномочия нет у вас самих`;
  }
  return null;
}

/** Изменения прав для журнала: «Касса и смены: Видит → Правит», «Сторно в открытой смене: нет → да». */
export function rightsDiff(before: Rights, after: Rights): Record<string, [string, string]> {
  const out: Record<string, [string, string]> = {};
  for (const s of SECTIONS) {
    const a = levelOf(before, s.key);
    const b = levelOf(after, s.key);
    if (a !== b) out[s.title] = [LEVEL_LABELS[a], LEVEL_LABELS[b]];
  }
  for (const p of POWERS) {
    const a = before.powers.includes(p.key);
    const b = after.powers.includes(p.key);
    if (a !== b) out[p.title] = [a ? 'да' : 'нет', b ? 'да' : 'нет'];
  }
  return out;
}

export function sameRights(a: Rights, b: Rights): boolean {
  return Object.keys(rightsDiff(a, b)).length === 0;
}

const r = (sections: Rights['sections'], powers: PowerKey[] = []): Rights => ({ sections, powers });

/**
 * Должности новой гостиницы - то, что владелец увидит в списке при первом
 * найме. Это не роли: их переименовывают, удаляют и дополняют, а права
 * подставляются в карточку человека и дальше правятся у него.
 */
export const DEFAULT_POSITIONS: { name: string; requireTotp: boolean; rights: Rights }[] = [
  { name: 'Управляющий', requireTotp: true, rights: allRights() },
  {
    name: 'Старший администратор',
    requireTotp: false,
    rights: r(
      { bookings: 'edit', frontdesk: 'edit', guests: 'edit', folio: 'edit', cash: 'edit', housekeeping: 'edit', maintenance: 'view', attendance: 'view', staff: 'view', reports: 'view' },
      ['special_price', 'storno', 'checkout_debt', 'guest_admin', 'block_rooms'],
    ),
  },
  {
    name: 'Администратор ресепшена',
    requireTotp: false,
    rights: r({ bookings: 'edit', frontdesk: 'edit', guests: 'edit', folio: 'edit', cash: 'edit', housekeeping: 'view', maintenance: 'view' }),
  },
  { name: 'Оператор колл-центра', requireTotp: false, rights: r({ bookings: 'edit', guests: 'edit' }) },
  { name: 'Менеджер по залам', requireTotp: false, rights: r({ bookings: 'view', guests: 'edit' }) },
  { name: 'Горничная', requireTotp: false, rights: r({ cleaning: 'edit' }) },
  { name: 'Супервайзер хозслужбы', requireTotp: false, rights: r({ housekeeping: 'edit', cleaning: 'edit', maintenance: 'view' }, ['block_rooms']) },
  { name: 'Техник', requireTotp: false, rights: r({ maintenance: 'edit' }) },
  { name: 'Бухгалтер', requireTotp: true, rights: r({ bookings: 'view', guests: 'view', folio: 'view', cash: 'view', attendance: 'view', reports: 'view' }) },
];

/** Каталог для экрана прав: разделы группами и полномочия. */
export function accessCatalog() {
  return {
    sections: SECTIONS.map((s) => ({ key: s.key, title: s.title, group: s.group, levels: [...s.levels], hint: s.hint })),
    powers: POWERS.map((p) => ({ key: p.key, title: p.title, hint: p.hint })),
  };
}
