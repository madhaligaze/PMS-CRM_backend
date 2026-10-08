import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import type { PropertyContext } from '../core/context.ts';
import { buildReport } from '../modules/cash/service.ts';
import { DEPARTURE_CHECKLIST } from '../modules/bookings/service.ts';
import { GENERAL_CHECKLIST } from '../modules/housekeeping/service.ts';
import { quote } from '../modules/rates/pricing.ts';
import { allRights, DEFAULT_POSITIONS, permissionsFor, type Access } from '../lib/access.ts';
import { hashSecret } from '../lib/crypto.ts';
import { addDays, businessDate, isoWeekday, zonedToUtc } from '../lib/dates.ts';
import { newId } from '../lib/ids.ts';
import { iinControlDigit } from '../lib/iin.ts';
import { normalizeDocNumber, normalizePhone } from '../lib/normalize.ts';
import { DEFAULT_CURRENCY, DEFAULT_SETTINGS, DEFAULT_TIMEZONE } from '../modules/property/defaults.ts';
import { createDefaultPositions } from '../modules/staff/service.ts';
import { createDb, type Db } from './client.ts';
import {
  attendanceEvents,
  auditLog,
  bookingGroups,
  bookings,
  cashMovements,
  cashRegisters,
  cashShifts,
  companies,
  counters,
  folioItems,
  guests,
  hkTasks,
  maintenanceRequests,
  memberships,
  orgs,
  payments,
  properties,
  ratePlans,
  ratePrices,
  roomBlocks,
  rooms,
  roomTypes,
  users,
} from './schema/index.ts';

/**
 * Демо-данные: номерной фонд, сотрудники на каждую роль, база гостей, три
 * недели истории со сменами и Z-отчётами, живой сегодняшний день. Все даты
 * считаются от операционной даты гостиницы, поэтому демо всегда «сейчас».
 *
 * Размер - не константа системы, а значение по умолчанию для демо. Номерной
 * фонд задаётся DEMO_ROOMS («тип:количество:этаж» через запятую); номера сверх
 * сценария получают сгенерированную историю. В работе номера, типы и
 * сотрудники заводятся в настройках без ограничений.
 */

const TZ = DEFAULT_TIMEZONE;
const DEMO_PASSWORD = 'demo12345';
const DEMO_PIN = '1234';
/** Тенге в тиынах: суммы в базе - в минимальных единицах валюты. */
const tenge = (v: number) => v * 100;

const SETTINGS = DEFAULT_SETTINGS;

/**
 * Люди демо: владелец зарегистрировал гостиницу, остальных нанял он сам.
 * Должности - из списка по умолчанию, права - из должности.
 */
const STAFF: { login: string; name: string; position: string; access?: Access }[] = [
  { login: 'owner', name: 'Бауыржан Есенов', position: 'Управляющий', access: 'owner' },
  { login: 'senior', name: 'Әсем Жақыпова', position: 'Старший администратор' },
  { login: 'reception', name: 'Жансая Тұрсынова', position: 'Администратор ресепшена' },
  { login: 'reception2', name: 'Дильназ Ермекова', position: 'Администратор ресепшена' },
  { login: 'night', name: 'Дәулет Оспанов', position: 'Администратор ресепшена' },
  { login: 'callcenter', name: 'Алия Құдайбергенова', position: 'Оператор колл-центра' },
  { login: 'callcenter2', name: 'Інкәр Сұлтанова', position: 'Оператор колл-центра' },
  { login: 'events', name: 'Ерасыл Нұрмағамбетов', position: 'Менеджер по залам' },
  { login: 'maid', name: 'Гүлнар Иманғалиева', position: 'Горничная' },
  { login: 'maid2', name: 'Сәуле Тілеуова', position: 'Горничная' },
  { login: 'maid3', name: 'Ақбота Серікбаева', position: 'Горничная' },
  { login: 'supervisor', name: 'Жанар Мұқатаева', position: 'Супервайзер хозслужбы' },
  { login: 'tech', name: 'Қайрат Шәкенов', position: 'Техник' },
  { login: 'accountant', name: 'Ләззат Мұхамеджанова', position: 'Бухгалтер' },
];

type GuestSeed = {
  key: string;
  last: string;
  first: string;
  middle?: string;
  birth: string;
  gender: 'm' | 'f';
  cz: string;
  doc: 'passport' | 'id_card' | 'foreign_passport';
  no: string;
  phone: string;
  email?: string;
  lang?: string;
  company?: string;
  vip?: boolean;
  black?: string;
  prefs?: { roomType?: string; allergies?: string; notes?: string };
  consent?: boolean;
  issuedBy?: string;
};

/**
 * Гости. Граждане Казахстана - с удостоверением личности (9 цифр) или
 * паспортом РК (N и 8 цифр); ИИН считается из даты рождения и пола.
 * Телефоны - в том виде, как их диктуют: с +7 и с восьмёркой.
 */
const GUESTS: GuestSeed[] = [
  { key: 'seidakhmetova', last: 'Сейдахметова', first: 'Мадина', middle: 'Маратовна', birth: '1988-04-12', gender: 'f', cz: 'KAZ', doc: 'id_card', no: '041236587', phone: '8 701 123 45 67', lang: 'kk', email: 'madina.seid@mail.kz', consent: true, issuedBy: 'МВД РК' },
  { key: 'nurgaliev', last: 'Нургалиев', first: 'Ержан', middle: 'Болатович', birth: '1979-11-02', gender: 'm', cz: 'KAZ', doc: 'passport', no: 'N04512378', phone: '+7 777 234 56 78', vip: true, prefs: { roomType: 'Люкс', notes: 'Любит номер 203, просит поздний выезд' }, consent: true, issuedBy: 'МВД РК' },
  { key: 'abenova', last: 'Абенова', first: 'Жанель', middle: 'Ерлановна', birth: '1993-07-21', gender: 'f', cz: 'KAZ', doc: 'id_card', no: '038745126', phone: '+7 707 345 67 89' },
  { key: 'zhumagulov', last: 'Жумагулов', first: 'Ерболат', middle: 'Канатович', birth: '1985-01-30', gender: 'm', cz: 'KAZ', doc: 'id_card', no: '027365491', phone: '+7 701 456 78 90', company: 'saryarka', consent: true },
  { key: 'tleubaev', last: 'Тлеубаев', first: 'Даурен', middle: 'Серикович', birth: '1990-03-08', gender: 'm', cz: 'KAZ', doc: 'id_card', no: '036598214', phone: '8 705 567 89 01', lang: 'kk', company: 'saryarka' },
  { key: 'akhmetzhanova', last: 'Ахметжанова', first: 'Томирис', middle: 'Нурлановна', birth: '1996-12-25', gender: 'f', cz: 'KAZ', doc: 'id_card', no: '045872369', phone: '+7 747 678 90 12', email: 'tomiris.a@gmail.com', consent: true },
  { key: 'baitenov', last: 'Байтенов', first: 'Арман', middle: 'Нурланович', birth: '1983-05-17', gender: 'm', cz: 'KAZ', doc: 'passport', no: 'N03659874', phone: '+7 702 789 01 23' },
  { key: 'zhunusova', last: 'Жунусова', first: 'Бахыт', middle: 'Амангельдиевна', birth: '1969-02-11', gender: 'f', cz: 'KAZ', doc: 'id_card', no: '019463527', phone: '8 777 890 12 34', lang: 'kk' },
  { key: 'utepova', last: 'Утепова', first: 'Акмарал', birth: '2000-01-15', gender: 'f', cz: 'KAZ', doc: 'id_card', no: '049125836', phone: '+7 708 901 23 45', email: 'akmaral.u@mail.ru' },
  { key: 'kuanyshev', last: 'Куанышев', first: 'Ернар', middle: 'Маратович', birth: '1991-06-28', gender: 'm', cz: 'KAZ', doc: 'id_card', no: '037451298', phone: '+7 701 012 34 56', company: 'saryarka', consent: true },
  { key: 'ibraev', last: 'Ибраев', first: 'Тимур', middle: 'Рустамович', birth: '1984-04-04', gender: 'm', cz: 'KAZ', doc: 'passport', no: 'N02874563', phone: '+7 705 123 78 90', company: 'travel', consent: true },
  { key: 'tulegenov', last: 'Тулегенов', first: 'Санжар', birth: '1995-09-09', gender: 'm', cz: 'KAZ', doc: 'id_card', no: '039581274', phone: '+7 702 234 89 01' },
  { key: 'smagulova', last: 'Смагулова', first: 'Арайлым', birth: '1989-11-11', gender: 'f', cz: 'KAZ', doc: 'id_card', no: '032149875', phone: '+7 778 345 90 12' },
  { key: 'baimukhanov', last: 'Баймуханов', first: 'Айдос', birth: '1982-12-12', gender: 'm', cz: 'KAZ', doc: 'passport', no: 'N01597346', phone: '8 701 456 01 23', consent: true },
  { key: 'sarbasov', last: 'Сарбасов', first: 'Бакытжан', birth: '1974-05-05', gender: 'm', cz: 'KAZ', doc: 'id_card', no: '012587463', phone: '+7 777 567 12 34', consent: true },
  { key: 'kenesova', last: 'Кенесова', first: 'Шолпан', birth: '1991-01-21', gender: 'f', cz: 'KAZ', doc: 'id_card', no: '035874126', phone: '+7 701 678 23 45', consent: true },
  { key: 'zhakupov', last: 'Жакупов', first: 'Алмас', birth: '1986-10-14', gender: 'm', cz: 'KAZ', doc: 'id_card', no: '031476952', phone: '+7 707 789 34 56', consent: true },
  { key: 'temirbaeva', last: 'Темирбаева', first: 'Аружан', birth: '2001-03-30', gender: 'f', cz: 'KAZ', doc: 'id_card', no: '048563217', phone: '+7 747 890 45 67' },
  { key: 'rakhimzhanov', last: 'Рахимжанов', first: 'Ернур', birth: '1983-08-25', gender: 'm', cz: 'KAZ', doc: 'id_card', no: '028459163', phone: '8 702 901 56 78' },
  { key: 'zhaksylykov', last: 'Жаксылыков', first: 'Ерлан', middle: 'Серикович', birth: '1980-02-20', gender: 'm', cz: 'KAZ', doc: 'passport', no: 'N07834521', phone: '+7 701 555 20 80', vip: true, consent: true },
  { key: 'sarsenbaeva', last: 'Сарсенбаева', first: 'Айгерим', middle: 'Нурлановна', birth: '1992-05-05', gender: 'f', cz: 'KAZ', doc: 'id_card', no: '043218765', phone: '+7 702 234 56 78', consent: true },
  { key: 'omarov', last: 'Омаров', first: 'Асхат', birth: '1975-03-15', gender: 'm', cz: 'KAZ', doc: 'passport', no: 'N05617283', phone: '+7 705 345 67 89', consent: true },
  { key: 'baizhanova', last: 'Байжанова', first: 'Гаухар', birth: '1986-08-08', gender: 'f', cz: 'KAZ', doc: 'id_card', no: '026789134', phone: '+7 707 456 78 91', consent: true },
  { key: 'nurlanuly', last: 'Нұрланұлы', first: 'Әлихан', birth: '1999-04-01', gender: 'm', cz: 'KAZ', doc: 'id_card', no: '047812369', phone: '+7 708 567 89 01', lang: 'kk' },
  { key: 'kenzhebaeva', last: 'Кенжебаева', first: 'Ақерке', birth: '1997-06-12', gender: 'f', cz: 'KAZ', doc: 'id_card', no: '049876512', phone: '+7 747 312 40 18' },
  { key: 'ivanov', last: 'Иванов', first: 'Сергей', middle: 'Петрович', birth: '1970-01-01', gender: 'm', cz: 'RUS', doc: 'foreign_passport', no: '72 1234567', phone: '+7 916 123 4567', email: 's.ivanov@yandex.ru', consent: true },
  { key: 'smirnova', last: 'Смирнова', first: 'Ольга', middle: 'Викторовна', birth: '1983-06-16', gender: 'f', cz: 'RUS', doc: 'foreign_passport', no: '73 2345678', phone: '+7 925 234 5678', consent: true },
  { key: 'kuznetsov', last: 'Кузнецов', first: 'Андрей', middle: 'Алексеевич', birth: '1978-10-10', gender: 'm', cz: 'RUS', doc: 'foreign_passport', no: '74 3456789', phone: '+7 903 345 6789', black: 'Повреждение имущества в номере 105 в марте 2026, отказ компенсировать ущерб' },
  { key: 'popova', last: 'Попова', first: 'Екатерина', middle: 'Игоревна', birth: '1994-02-28', gender: 'f', cz: 'RUS', doc: 'foreign_passport', no: '75 4567890', phone: '+7 926 456 7890', consent: true },
  { key: 'volkov', last: 'Волков', first: 'Дмитрий', middle: 'Сергеевич', birth: '1988-09-30', gender: 'm', cz: 'RUS', doc: 'foreign_passport', no: '76 5678901', phone: '+7 915 567 8901' },
  { key: 'karimov', last: 'Каримов', first: 'Шерзод', birth: '1987-07-17', gender: 'm', cz: 'UZB', doc: 'foreign_passport', no: 'FA1234567', phone: '+998 90 123 4567', consent: true },
  { key: 'yusupova', last: 'Юсупова', first: 'Малика', birth: '1995-12-01', gender: 'f', cz: 'UZB', doc: 'foreign_passport', no: 'FA2345678', phone: '+998 91 234 5678', consent: true },
  { key: 'muller', last: 'Müller', first: 'Thomas', birth: '1965-05-22', gender: 'm', cz: 'DEU', doc: 'foreign_passport', no: 'C01X00T47', phone: '+49 151 2345 6789', email: 'thomas.mueller@web.de', lang: 'de', vip: true, prefs: { roomType: 'Люкс', notes: 'Тихий номер на втором этаже' }, consent: true },
  { key: 'schmidt', last: 'Schmidt', first: 'Anna', birth: '1990-08-14', gender: 'f', cz: 'DEU', doc: 'foreign_passport', no: 'C02Y11U58', phone: '+49 160 3456 7890', lang: 'de', consent: true },
  { key: 'kim', last: 'Kim', first: 'Minjun', birth: '1992-03-03', gender: 'm', cz: 'KOR', doc: 'foreign_passport', no: 'M12345678', phone: '+82 10 1234 5678', lang: 'en', consent: true },
  { key: 'lee', last: 'Lee', first: 'Soyeon', birth: '1994-11-20', gender: 'f', cz: 'KOR', doc: 'foreign_passport', no: 'M23456789', phone: '+82 10 2345 6789', lang: 'en', consent: true },
  { key: 'wang', last: 'Wang', first: 'Lei', birth: '1985-06-06', gender: 'm', cz: 'CHN', doc: 'foreign_passport', no: 'E12345678', phone: '+86 138 1234 5678', lang: 'zh', consent: true },
  { key: 'smith', last: 'Smith', first: 'John', birth: '1979-09-09', gender: 'm', cz: 'GBR', doc: 'foreign_passport', no: '123456789', phone: '+44 7700 900123', lang: 'en', prefs: { allergies: 'Орехи' }, consent: true },
  { key: 'dubois', last: 'Dubois', first: 'Claire', birth: '1987-04-18', gender: 'f', cz: 'FRA', doc: 'foreign_passport', no: '18AB12345', phone: '+33 6 12 34 56 78', lang: 'fr', consent: true },
  { key: 'yilmaz', last: 'Yılmaz', first: 'Mehmet', birth: '1981-12-30', gender: 'm', cz: 'TUR', doc: 'foreign_passport', no: 'U12345678', phone: '+90 532 123 4567', consent: true },
  { key: 'tanaka', last: 'Tanaka', first: 'Yuki', birth: '1996-07-07', gender: 'f', cz: 'JPN', doc: 'foreign_passport', no: 'TK1234567', phone: '+81 90 1234 5678', lang: 'en', consent: true },
];

type BookingSeed = {
  room: string;
  guest: string;
  from: number;
  to: number;
  status: 'tentative' | 'confirmed' | 'checked_in' | 'checked_out' | 'cancelled' | 'no_show';
  plan?: 'BAR' | 'BB' | 'CORP' | 'GRP';
  source: 'phone' | 'walk_in' | 'website' | 'whatsapp' | 'instagram' | 'booking_com' | 'ota_other' | 'email';
  method: 'cash' | 'card' | 'qr' | 'invoice';
  adults?: number;
  children?: number;
  discount?: { percent: number; reason: string };
  special?: { nightly: number; basis: string };
  /** Сколько оплачено: 'full' - всё к выезду, 'prepay' - первую ночь, 'none', или сумма в тенге. */
  paid?: 'full' | 'prepay' | 'none' | number;
  rating?: number;
  feedback?: string;
  reason?: string;
  group?: string;
  comment?: string;
  /** Срок предоплаты в часах от «сейчас» для предварительных броней. */
  dueInHours?: number;
  charges?: { kind: 'minibar' | 'restaurant' | 'laundry' | 'transfer' | 'damage'; text: string; qty: number; price: number }[];
  createdBy?: string;
};

const BOOKINGS: BookingSeed[] = [
  // Выселенные: история и выручка.
  { room: '101', guest: 'ivanov', from: -20, to: -17, status: 'checked_out', source: 'booking_com', method: 'cash', paid: 'full' },
  { room: '102', guest: 'kim', from: -19, to: -15, status: 'checked_out', source: 'website', method: 'card', paid: 'full', rating: 5 },
  { room: '103', guest: 'zhumagulov', from: -18, to: -14, status: 'checked_out', plan: 'CORP', source: 'phone', method: 'invoice', paid: 'full' },
  { room: '201', guest: 'zhaksylykov', from: -17, to: -13, status: 'checked_out', plan: 'BB', source: 'whatsapp', method: 'cash', adults: 2, children: 2, paid: 'full', rating: 5, feedback: 'Детям очень понравилось, спасибо за завтраки' },
  { room: '104', guest: 'smirnova', from: -16, to: -12, status: 'checked_out', source: 'walk_in', method: 'cash', paid: 'full', charges: [{ kind: 'minibar', text: 'Мини-бар: вода, шоколад', qty: 1, price: 2_500 }] },
  { room: '106', guest: 'muller', from: -15, to: -11, status: 'checked_out', source: 'booking_com', method: 'card', paid: 'full', rating: 5, feedback: 'Тихо, вид на горы, отличный завтрак' },
  { room: '203', guest: 'nurgaliev', from: -14, to: -10, status: 'checked_out', source: 'phone', method: 'cash', special: { nightly: 42_000, basis: 'Постоянный гость' }, paid: 'full' },
  { room: '105', guest: 'popova', from: -13, to: -9, status: 'checked_out', source: 'instagram', method: 'card', discount: { percent: 10, reason: 'Повторный визит' }, paid: 'full' },
  { room: '107', guest: 'karimov', from: -12, to: -8, status: 'checked_out', source: 'phone', method: 'cash', paid: 'full', charges: [{ kind: 'laundry', text: 'Прачечная: 2 рубашки', qty: 2, price: 1_500 }] },
  { room: '202', guest: 'sarsenbaeva', from: -11, to: -7, status: 'checked_out', source: 'website', method: 'qr', adults: 3, paid: 'full', rating: 4 },
  { room: '101', guest: 'smith', from: -10, to: -6, status: 'checked_out', source: 'booking_com', method: 'card', paid: 'full', rating: 4, feedback: 'Хорошо, но хотелось бы кондиционер потише' },
  { room: '102', guest: 'yusupova', from: -9, to: -6, status: 'checked_out', source: 'whatsapp', method: 'qr', paid: 'full' },
  { room: '104', guest: 'wang', from: -8, to: -5, status: 'checked_out', source: 'ota_other', method: 'card', paid: 'full', charges: [{ kind: 'transfer', text: 'Трансфер из аэропорта', qty: 1, price: 12_000 }] },
  { room: '106', guest: 'ibraev', from: -7, to: -3, status: 'checked_out', plan: 'CORP', source: 'phone', method: 'invoice', paid: 'full' },
  { room: '203', guest: 'dubois', from: -6, to: -3, status: 'checked_out', source: 'booking_com', method: 'card', paid: 'full', rating: 5 },
  { room: '107', guest: 'tleubaev', from: -6, to: -4, status: 'checked_out', source: 'walk_in', method: 'cash', paid: 'full' },
  { room: '101', guest: 'schmidt', from: -5, to: -2, status: 'checked_out', source: 'website', method: 'card', paid: 'full' },
  { room: '201', guest: 'omarov', from: -6, to: -2, status: 'checked_out', plan: 'BB', source: 'phone', method: 'cash', adults: 2, children: 1, paid: 'full', charges: [{ kind: 'restaurant', text: 'Ресторан: ужин на троих', qty: 1, price: 24_000 }] },
  { room: '103', guest: 'yilmaz', from: -7, to: -2, status: 'checked_out', source: 'booking_com', method: 'card', paid: 'full' },
  { room: '102', guest: 'lee', from: -4, to: -1, status: 'checked_out', source: 'booking_com', method: 'card', paid: 'full', rating: 3, feedback: 'Ночью шумно со стороны дороги' },
  { room: '105', guest: 'akhmetzhanova', from: -4, to: 0, status: 'checked_out', source: 'instagram', method: 'qr', paid: 'full' },
  { room: '202', guest: 'baimukhanov', from: -3, to: 0, status: 'checked_out', source: 'phone', method: 'cash', paid: 'full' },
  { room: '203', guest: 'tanaka', from: -2, to: 0, status: 'checked_out', source: 'booking_com', method: 'card', paid: 'full', rating: 5 },
  // Отмены и незаезд.
  { room: '104', guest: 'volkov', from: 3, to: 5, status: 'cancelled', source: 'phone', method: 'cash', reason: 'Изменились планы' },
  { room: '107', guest: 'tulegenov', from: -2, to: -1, status: 'no_show', source: 'phone', method: 'cash', reason: 'Гость не приехал и не отвечает' },
  { room: '201', guest: 'smagulova', from: 9, to: 12, status: 'cancelled', source: 'instagram', method: 'cash', reason: 'Гость выбрал другое жильё' },
  // Живут сейчас.
  { room: '103', guest: 'sarbasov', from: -1, to: 3, status: 'checked_in', source: 'phone', method: 'cash', paid: 22_000 },
  { room: '104', guest: 'kenesova', from: -3, to: 0, status: 'checked_in', source: 'walk_in', method: 'cash', paid: 44_000, charges: [{ kind: 'minibar', text: 'Мини-бар: сок, орехи', qty: 1, price: 2_200 }] },
  { room: '106', guest: 'kuanyshev', from: -2, to: 2, status: 'checked_in', plan: 'CORP', source: 'phone', method: 'invoice', paid: 'none' },
  { room: '201', guest: 'baizhanova', from: -1, to: 2, status: 'checked_in', source: 'whatsapp', method: 'card', adults: 1, children: 1, paid: 'full' },
  { room: '107', guest: 'zhakupov', from: -3, to: 3, status: 'checked_in', source: 'booking_com', method: 'card', paid: 'prepay' },
  // Заезды сегодня.
  { room: '102', guest: 'temirbaeva', from: 0, to: 2, status: 'confirmed', source: 'website', method: 'card', paid: 'prepay' },
  { room: '105', guest: 'rakhimzhanov', from: 0, to: 3, status: 'tentative', source: 'phone', method: 'cash', paid: 'none', dueInHours: 3, createdBy: 'callcenter' },
  { room: '202', guest: 'kenzhebaeva', from: 0, to: 4, status: 'confirmed', source: 'booking_com', method: 'card', adults: 2, paid: 'prepay' },
  // Будущие.
  { room: '101', guest: 'nurlanuly', from: 1, to: 4, status: 'confirmed', source: 'website', method: 'card', paid: 'prepay' },
  { room: '104', guest: 'zhunusova', from: 1, to: 3, status: 'tentative', source: 'phone', method: 'cash', paid: 'none', dueInHours: -2, createdBy: 'callcenter2', comment: 'Обещала перевести предоплату вчера вечером' },
  { room: '203', guest: 'muller', from: 2, to: 5, status: 'confirmed', source: 'booking_com', method: 'card', paid: 'prepay', comment: 'VIP, тихий номер, встретить с водой' },
  { room: '103', guest: 'baitenov', from: 4, to: 7, status: 'confirmed', source: 'phone', method: 'cash', paid: 'prepay' },
  { room: '108', guest: 'abenova', from: 3, to: 6, status: 'tentative', source: 'instagram', method: 'qr', paid: 'none', dueInHours: 30 },
  { room: '105', guest: 'zhumagulov', from: 5, to: 8, status: 'confirmed', plan: 'CORP', source: 'email', method: 'invoice', group: 'saryarka', paid: 'none' },
  { room: '106', guest: 'kuanyshev', from: 5, to: 8, status: 'confirmed', plan: 'CORP', source: 'email', method: 'invoice', group: 'saryarka', paid: 'none' },
  { room: '107', guest: 'tleubaev', from: 5, to: 8, status: 'confirmed', plan: 'CORP', source: 'email', method: 'invoice', group: 'saryarka', paid: 'none' },
  { room: '201', guest: 'utepova', from: 6, to: 10, status: 'tentative', source: 'whatsapp', method: 'cash', adults: 2, children: 2, paid: 'none', dueInHours: 40 },
  { room: '102', guest: 'kim', from: 8, to: 11, status: 'confirmed', source: 'website', method: 'card', paid: 'prepay' },
  { room: '104', guest: 'smith', from: 10, to: 14, status: 'confirmed', source: 'booking_com', method: 'card', paid: 'prepay' },
  { room: '202', guest: 'seidakhmetova', from: 12, to: 15, status: 'tentative', source: 'instagram', method: 'cash', paid: 'none', dueInHours: 48 },
  { room: '101', guest: 'ivanov', from: 15, to: 20, status: 'confirmed', source: 'booking_com', method: 'card', paid: 'prepay' },
  { room: '105', guest: 'yusupova', from: 12, to: 16, status: 'confirmed', source: 'website', method: 'qr', paid: 'prepay' },
];

/** Номерной фонд демо по умолчанию: «тип:количество:этаж». Номера нумеруются по этажам: 101, 102... */
const DEFAULT_ROOMS = 'STD:5:1,TWN:3:1,FAM:2:2,LUX:1:2';
type TypeCode = 'STD' | 'TWN' | 'FAM' | 'LUX';

function parseRoomPlan(spec: string): [string, TypeCode, number][] {
  const perFloor = new Map<number, number>();
  const out: [string, TypeCode, number][] = [];
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [type, count, floor] = part.split(':');
    if (!['STD', 'TWN', 'FAM', 'LUX'].includes(type ?? '')) throw new Error(`DEMO_ROOMS: неизвестный тип «${type}»`);
    const n = Number(count);
    const f = Number(floor ?? 1);
    if (!Number.isInteger(n) || n < 1 || !Number.isInteger(f) || f < 1) throw new Error(`DEMO_ROOMS: неверная часть «${part}»`);
    for (let i = 0; i < n; i++) {
      const idx = (perFloor.get(f) ?? 0) + 1;
      perFloor.set(f, idx);
      out.push([`${f}${String(idx).padStart(2, '0')}`, type as TypeCode, f]);
    }
  }
  return out;
}

/**
 * История для номеров сверх сценария: подряд идущие проживания с паузами,
 * статус - по дате относительно сегодняшнего дня.
 */
function fillerBookings(roomNumbers: string[], rand: () => number): BookingSeed[] {
  const out: BookingSeed[] = [];
  const sources: BookingSeed['source'][] = ['booking_com', 'website', 'phone', 'walk_in', 'whatsapp', 'instagram'];
  const methods: BookingSeed['method'][] = ['cash', 'card', 'qr'];
  for (const room of roomNumbers) {
    let day = -20 + Math.floor(rand() * 4);
    while (day < 25) {
      const nights = 1 + Math.floor(rand() * 4);
      const from = day;
      const to = day + nights;
      const guest = GUESTS[Math.floor(rand() * GUESTS.length)]!;
      if (guest.black) {
        day = to;
        continue;
      }
      const status: BookingSeed['status'] = to <= 0 ? 'checked_out' : from <= 0 ? 'checked_in' : rand() < 0.75 ? 'confirmed' : 'tentative';
      out.push({
        room,
        guest: guest.key,
        from,
        to,
        status,
        source: sources[Math.floor(rand() * sources.length)]!,
        method: methods[Math.floor(rand() * methods.length)]!,
        paid: status === 'checked_out' ? 'full' : status === 'checked_in' ? 'prepay' : status === 'confirmed' ? 'prepay' : 'none',
        ...(status === 'tentative' ? { dueInHours: 24 + Math.floor(rand() * 48) } : {}),
      });
      day = to + Math.floor(rand() * 3);
    }
  }
  return out;
}

/** Детерминированный генератор: сид даёт одинаковое демо при каждом запуске. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Начало номера плюс порядковый номер; номер, для которого контрольная цифра не выдаётся, пропускается. */
function withControlDigit(prefix: string, serial: number): string {
  for (let s = serial; ; s++) {
    const body = prefix + String(s).padStart(11 - prefix.length, '0');
    const control = iinControlDigit(body);
    if (control !== null) return body + control;
  }
}

/** Демо-ИИН: дата рождения ГГММДД, век и пол (3/4 - XX век, 5/6 - XXI), порядковый номер. */
function demoIin(birth: string, gender: 'm' | 'f', serial: number): string {
  const marker = (birth.startsWith('19') ? 3 : 5) + (gender === 'f' ? 1 : 0);
  return withControlDigit(`${birth.slice(2, 4)}${birth.slice(5, 7)}${birth.slice(8, 10)}${marker}`, serial);
}

/** Демо-БИН: год и месяц регистрации, юрлицо-резидент (4), головная организация (0). */
function demoBin(yymm: string, serial: number): string {
  return withControlDigit(`${yymm}40`, serial);
}

export async function seed(db: Db, log: (msg: string) => void = console.log) {
  const [existing] = await db.select({ id: orgs.id }).from(orgs).limit(1);
  if (existing) {
    log('База уже заполнена - сид пропущен. Для чистого демо: pnpm db:reset');
    return;
  }
  const rand = prng(20261007);
  const now = new Date();
  const T = businessDate(now, TZ);
  const at = (dayOffset: number, hhmm: string) => zonedToUtc(addDays(T, dayOffset), hhmm, TZ);
  const jitter = (base: Date, minutes: number) => new Date(base.getTime() + Math.round((rand() * 2 - 1) * minutes) * 60_000);
  /** Событие «сегодня в 11:00» при запуске сида в 09:00 сдвигается в прошлое. */
  const past = (d: Date) => (d.getTime() > now.getTime() ? new Date(now.getTime() - Math.round(5 + rand() * 40) * 60_000) : d);

  const orgId = newId();
  const propertyId = newId();
  await db.insert(orgs).values({ id: orgId, name: 'Bizdin Auyl' });
  await db.insert(properties).values({ id: propertyId, orgId, name: 'Bizdin Auyl', timezone: TZ, currency: DEFAULT_CURRENCY, settings: SETTINGS });

  // ── Должности и сотрудники ──────────────────────────────────────────────
  const positionIds = await createDefaultPositions(db, orgId);
  const passwordHash = await hashSecret(DEMO_PASSWORD);
  const pinHash = await hashSecret(DEMO_PIN);
  const staff = new Map<string, { id: string; name: string }>();
  for (const s of STAFF) {
    const id = newId();
    const access = s.access ?? 'staff';
    const template = DEFAULT_POSITIONS.find((p) => p.name === s.position)!;
    staff.set(s.login, { id, name: s.name });
    await db.insert(users).values({
      id,
      orgId,
      login: s.login,
      fullName: s.name,
      passwordHash,
      pinHash,
      totpRequired: access !== 'staff' || template.requireTotp,
      passwordChangedAt: at(-40, '10:00'),
      createdAt: at(-60 + Math.floor(rand() * 20), '10:00'),
    });
    await db.insert(memberships).values({ userId: id, propertyId, access, positionId: positionIds.get(s.position)!, rights: access === 'staff' ? template.rights : allRights() });
  }
  const who = (login: string) => staff.get(login)!;
  const owner = who('owner');

  const ctx: PropertyContext = {
    orgId,
    propertyId,
    property: { name: 'Bizdin Auyl', timezone: TZ, currency: DEFAULT_CURRENCY, checkInTime: '14:00', checkOutTime: '12:00', settings: SETTINGS },
    actor: { id: owner.id, name: owner.name },
    access: 'owner',
    rights: allRights(),
    permissions: permissionsFor('owner', allRights()),
    requestId: null,
    ip: null,
  };

  // ── Номерной фонд ───────────────────────────────────────────────────────
  const types = {
    STD: { id: newId(), code: 'STD', name: 'Стандарт', baseOccupancy: 2, maxOccupancy: 3, sort: 1, description: 'Двуспальная кровать, душ, вид во двор' },
    TWN: { id: newId(), code: 'TWN', name: 'Твин', baseOccupancy: 2, maxOccupancy: 2, sort: 2, description: 'Две отдельные кровати' },
    FAM: { id: newId(), code: 'FAM', name: 'Семейный', baseOccupancy: 4, maxOccupancy: 5, sort: 3, description: 'Две комнаты, диван для детей' },
    LUX: { id: newId(), code: 'LUX', name: 'Люкс', baseOccupancy: 2, maxOccupancy: 3, sort: 4, description: 'Гостиная, ванна, терраса с видом на горы' },
  };
  for (const t of Object.values(types)) await db.insert(roomTypes).values({ ...t, propertyId });

  const roomPlan = parseRoomPlan(process.env.DEMO_ROOMS ?? DEFAULT_ROOMS);
  const roomIds = new Map<string, { id: string; typeId: string }>();
  for (const [i, [number, type, floor]] of roomPlan.entries()) {
    const id = newId();
    roomIds.set(number, { id, typeId: types[type].id });
    await db.insert(rooms).values({ id, propertyId, roomTypeId: types[type].id, number, floor, sort: i, hkStatus: 'inspected' });
  }

  // ── Тарифы ──────────────────────────────────────────────────────────────
  const plans = {
    BAR: { id: newId(), code: 'BAR', name: 'Стандартный', kind: 'standard' as const, includesBreakfast: false, sort: 1 },
    BB: { id: newId(), code: 'BB', name: 'С завтраком', kind: 'standard' as const, includesBreakfast: true, sort: 2 },
    CORP: { id: newId(), code: 'CORP', name: 'Корпоративный', kind: 'corporate' as const, includesBreakfast: true, sort: 3 },
    GRP: { id: newId(), code: 'GRP', name: 'Групповой', kind: 'group' as const, includesBreakfast: false, sort: 4 },
  };
  for (const p of Object.values(plans)) await db.insert(ratePlans).values({ ...p, propertyId });

  const yearFrom = `${T.slice(0, 4)}-01-01`;
  const yearTo = `${Number(T.slice(0, 4)) + 1}-12-31`;
  const prices: { plan: keyof typeof plans; label: string; from: string; to: string; weekdays: number[]; priority: number; amounts: Record<keyof typeof types, number> }[] = [
    { plan: 'BAR', label: 'Базовая', from: yearFrom, to: yearTo, weekdays: [1, 2, 3, 4, 5, 6, 7], priority: 0, amounts: { STD: 22_000, TWN: 22_000, FAM: 38_000, LUX: 55_000 } },
    { plan: 'BAR', label: 'Выходные', from: yearFrom, to: yearTo, weekdays: [5, 6], priority: 5, amounts: { STD: 25_000, TWN: 25_000, FAM: 43_000, LUX: 62_000 } },
    { plan: 'BB', label: 'Базовая', from: yearFrom, to: yearTo, weekdays: [1, 2, 3, 4, 5, 6, 7], priority: 0, amounts: { STD: 28_000, TWN: 28_000, FAM: 50_000, LUX: 61_000 } },
    { plan: 'BB', label: 'Выходные', from: yearFrom, to: yearTo, weekdays: [5, 6], priority: 5, amounts: { STD: 31_000, TWN: 31_000, FAM: 55_000, LUX: 68_000 } },
    { plan: 'CORP', label: 'По договору', from: yearFrom, to: yearTo, weekdays: [1, 2, 3, 4, 5, 6, 7], priority: 0, amounts: { STD: 24_000, TWN: 24_000, FAM: 42_000, LUX: 56_000 } },
    { plan: 'GRP', label: 'Группы от 5 номеров', from: yearFrom, to: yearTo, weekdays: [1, 2, 3, 4, 5, 6, 7], priority: 0, amounts: { STD: 19_000, TWN: 19_000, FAM: 33_000, LUX: 46_000 } },
  ];
  for (const y of [Number(T.slice(0, 4)), Number(T.slice(0, 4)) + 1]) {
    prices.push(
      { plan: 'BAR', label: `Высокий сезон ${y}`, from: `${y}-06-15`, to: `${y}-08-31`, weekdays: [1, 2, 3, 4, 5, 6, 7], priority: 10, amounts: { STD: 32_000, TWN: 32_000, FAM: 52_000, LUX: 75_000 } },
      { plan: 'BB', label: `Высокий сезон ${y}`, from: `${y}-06-15`, to: `${y}-08-31`, weekdays: [1, 2, 3, 4, 5, 6, 7], priority: 10, amounts: { STD: 38_000, TWN: 38_000, FAM: 64_000, LUX: 81_000 } },
    );
  }
  for (const pr of prices) {
    for (const [type, amount] of Object.entries(pr.amounts) as [keyof typeof types, number][]) {
      await db.insert(ratePrices).values({
        id: newId(),
        propertyId,
        ratePlanId: plans[pr.plan].id,
        roomTypeId: types[type].id,
        label: pr.label,
        validFrom: pr.from,
        validTo: pr.to,
        weekdays: pr.weekdays,
        amount: tenge(amount),
        priority: pr.priority,
      });
    }
  }

  // ── Компании и гости ───────────────────────────────────────────────────
  const companyIds = new Map<string, string>();
  const companySeed = [
    { key: 'saryarka', name: 'ТОО «Сарыарқа Инжиниринг»', taxId: demoBin('1804', 1234), contactName: 'Жумагулов Ерболат', phone: '+7 7172 57 12 34', email: 'office@saryarka-eng.kz', notes: 'Договор на корпоративный тариф до конца года. Счёт - ежемесячно.' },
    { key: 'travel', name: 'ТОО «Шұғыла Тревел»', taxId: demoBin('1907', 5678), contactName: 'Ибраев Тимур', phone: '+7 727 344 56 78', email: 'booking@shugyla-travel.kz', notes: 'Турагентство: группы летом, комиссия 10%.' },
    { key: 'fund', name: 'ОФ «Таза Өзен»', taxId: demoBin('0911', 9012), contactName: 'Есмагамбетова Айнур', phone: '+7 727 233 44 55', email: 'info@tazaozen.kz', notes: 'Семинары в конференц-зале весной и осенью.' },
  ];
  for (const c of companySeed) {
    const id = newId();
    companyIds.set(c.key, id);
    const { key: _k, ...rest } = c;
    await db.insert(companies).values({ id, orgId, ...rest });
  }

  const guestIds = new Map<string, string>();
  for (const [i, g] of GUESTS.entries()) {
    const id = newId();
    guestIds.set(g.key, id);
    await db.insert(guests).values({
      id,
      orgId,
      lastName: g.last,
      firstName: g.first,
      middleName: g.middle ?? null,
      birthDate: g.birth,
      gender: g.gender,
      citizenship: g.cz,
      docType: g.doc,
      docNumber: g.no,
      docNumberNorm: normalizeDocNumber(g.no),
      docIssuedBy: g.issuedBy ?? null,
      personalNumber: g.cz === 'KAZ' ? demoIin(g.birth, g.gender, 100 + i) : null,
      phone: g.phone,
      phoneNorm: normalizePhone(g.phone),
      email: g.email ?? null,
      language: g.lang ?? 'ru',
      companyId: g.company ? companyIds.get(g.company)! : null,
      isVip: g.vip ?? false,
      blacklisted: !!g.black,
      blacklistReason: g.black ?? null,
      preferences: g.prefs ?? {},
      marketingConsent: !!g.email,
      marketingConsentAt: g.email ? at(-30, '12:00') : null,
      pdConsentAt: g.consent ? at(-25, '15:00') : null,
      pdConsentMethod: g.consent ? 'paper' : null,
      createdAt: at(-40 + Math.floor(rand() * 10), '12:00'),
      createdBy: who('reception').id,
    });
  }
  // Возможный дубль: колл-центр завёл гостью по телефону, без документа.
  await db.insert(guests).values({
    id: newId(),
    orgId,
    lastName: 'Сейдахметова',
    firstName: 'Мадина',
    phone: '+7 701 123 45 67',
    phoneNorm: normalizePhone('+7 701 123 45 67'),
    language: 'kk',
    notes: 'Звонила насчёт мая, просила семейный номер',
    createdAt: at(-3, '16:20'),
    createdBy: who('callcenter').id,
  });

  // ── План кассовых смен за три недели ───────────────────────────────────
  // Смены создаются по одной, как в жизни: открыть, провести оплаты, закрыть
  // Z-отчётом, открыть следующую. Две открытые смены на кассе база не пустит.
  const registerId = newId();
  await db.insert(cashRegisters).values({ id: registerId, propertyId, name: 'Ресепшен' });
  const admins = ['reception', 'reception2', 'night'];
  type ShiftInfo = { id: string; number: number; day: number; admin: string; openedAt: Date };
  const shifts: ShiftInfo[] = [];
  let shiftNumber = 0;
  for (let d = -21; d <= 0; d++) {
    shiftNumber += 1;
    const opened = jitter(at(d, '08:00'), 6);
    const openedAt = d === 0 && opened.getTime() > now.getTime() - 30 * 60_000 ? new Date(now.getTime() - 30 * 60_000) : opened;
    shifts.push({ id: newId(), number: shiftNumber, day: d, admin: admins[(d + 21) % 3]!, openedAt });
  }
  const shiftFor = (dayOffset: number) => shifts.find((s) => s.day === dayOffset) ?? shifts[shifts.length - 1]!;

  /** Оплата ждёт своей смены: номер документа даётся при проведении, по времени. */
  type PendingPayment = Omit<typeof payments.$inferInsert, 'number' | 'fiscalNumber'> & { id: string; shiftId: string; createdAt: Date };
  const pending: PendingPayment[] = [];

  // ── Брони ───────────────────────────────────────────────────────────────
  let bookingNumber = 1000;
  let paymentNumber = 0;
  const groupIds = new Map<string, string>();
  const offsiteGroup = newId();
  await db.insert(bookingGroups).values({
    id: offsiteGroup,
    propertyId,
    name: 'Выездное совещание «Сарыарқа Инжиниринг»',
    companyId: companyIds.get('saryarka')!,
    billing: 'single',
    comment: 'Три номера, оплата одним счётом по договору',
    createdBy: who('senior').id,
    createdAt: at(-6, '11:30'),
  });
  groupIds.set('saryarka', offsiteGroup);

  // Сценарий рассчитан на номера по умолчанию; номера, которых нет в фонде,
  // пропускаются, а номера сверх сценария получают свою историю.
  const scenario = BOOKINGS.filter((b) => roomIds.has(b.room));
  const scenarioRooms = new Set(scenario.map((b) => b.room));
  const extraRooms = [...roomIds.keys()].filter((n) => !scenarioRooms.has(n));
  const planned = [...scenario, ...fillerBookings(extraRooms, rand)];

  const bookingIdByKey = new Map<string, string>();
  for (const b of planned) {
    const room = roomIds.get(b.room)!;
    const planKey = b.plan ?? 'BAR';
    const arrival = addDays(T, b.from);
    const departure = addDays(T, b.to);
    const adults = b.adults ?? (b.room.startsWith('2') ? 2 : 1 + Math.floor(rand() * 2));
    const priceMode = b.special ? 'special' : b.discount ? 'discount' : 'rate';
    const q = await quote(db, ctx, {
      roomTypeId: room.typeId,
      ratePlanId: plans[planKey].id,
      arrival,
      departure,
      adults,
      meal: planKey === 'BB' || planKey === 'CORP' ? 'breakfast' : 'none',
      priceMode,
      discountPercent: b.discount?.percent ?? null,
      specialNightly: b.special ? tenge(b.special.nightly) : null,
    });
    const id = newId();
    bookingNumber += 1;
    const createdAt = jitter(at(b.from - 4 - Math.floor(rand() * 12), '14:00'), 240);
    const creator = b.createdBy ?? (b.source === 'phone' || b.source === 'whatsapp' || b.source === 'instagram' ? 'callcenter' : 'reception');
    const checkInAt = b.status === 'checked_in' || b.status === 'checked_out' ? past(jitter(at(b.from, '14:30'), 90)) : null;
    const checkOutAt = b.status === 'checked_out' ? past(jitter(at(b.to, '11:00'), 50)) : null;
    const companyId = b.method === 'invoice' ? (b.group ? companyIds.get(b.group)! : (GUESTS.find((g) => g.key === b.guest)?.company ? companyIds.get(GUESTS.find((g) => g.key === b.guest)!.company!)! : null)) : null;
    const prepaymentAmount = b.status === 'tentative' ? q.nights[0]!.amount : null;
    await db.insert(bookings).values({
      id,
      propertyId,
      number: bookingNumber,
      status: b.status,
      guestId: guestIds.get(b.guest)!,
      companyId,
      groupId: b.group ? groupIds.get(b.group)! : null,
      roomTypeId: room.typeId,
      roomId: room.id,
      arrival,
      departure,
      adults,
      children: b.children ?? 0,
      ratePlanId: plans[planKey].id,
      meal: planKey === 'BB' || planKey === 'CORP' ? 'breakfast' : 'none',
      source: b.source,
      paymentType: b.special ? 'special' : b.method === 'cash' ? 'cash' : 'cashless',
      priceMode,
      discountPercent: b.discount?.percent ?? null,
      specialNightly: b.special ? tenge(b.special.nightly) : null,
      priceReason: b.special?.basis ?? b.discount?.reason ?? null,
      priceApprovedBy: b.special ? owner.id : null,
      nights: q.nights,
      baseTotal: q.baseTotal,
      accommodationTotal: q.accommodationTotal,
      mealTotal: q.mealTotal,
      prepaymentAmount,
      prepaymentDueAt: b.status === 'tentative' && b.dueInHours != null ? new Date(now.getTime() + b.dueInHours * 3_600_000) : null,
      comment: b.comment ?? null,
      cancelReason: b.reason ?? null,
      cancelledAt: b.status === 'cancelled' || b.status === 'no_show' ? jitter(at(Math.min(b.from, 0) - 1, '18:00'), 120) : null,
      cancelledBy: b.status === 'cancelled' || b.status === 'no_show' ? who('reception2').id : null,
      checkedInAt: checkInAt,
      checkedInBy: checkInAt ? who(shiftFor(b.from).admin).id : null,
      keyIssuedAt: checkInAt,
      checkedOutAt: checkOutAt,
      checkedOutBy: checkOutAt ? who(shiftFor(b.to).admin).id : null,
      rating: b.rating ?? null,
      feedback: b.feedback ?? null,
      createdAt,
      createdBy: who(creator).id,
      updatedAt: checkOutAt ?? checkInAt ?? createdAt,
      updatedBy: who(creator).id,
    });
    bookingIdByKey.set(`${b.room}:${b.from}`, id);

    // Начисления.
    let chargesTotal = 0;
    for (const c of b.charges ?? []) {
      const amount = tenge(c.price) * c.qty;
      chargesTotal += amount;
      await db.insert(folioItems).values({
        id: newId(),
        propertyId,
        bookingId: id,
        kind: c.kind,
        description: c.text,
        quantity: c.qty,
        unitAmount: tenge(c.price),
        amount,
        serviceDate: addDays(T, Math.min(b.to - 1, 0)),
        createdAt: jitter(at(Math.min(b.to - 1, 0), '20:00'), 60),
        createdBy: who(shiftFor(Math.min(b.to - 1, 0)).admin).id,
      });
    }

    // Оплаты.
    const total = q.total + chargesTotal;
    const method = b.method === 'invoice' ? 'invoice' : b.method;
    const pay = async (amount: number, dayOffset: number, hhmm: string) => {
      if (amount <= 0) return;
      const day = Math.min(dayOffset, 0);
      const s = shiftFor(day);
      let when = jitter(at(day, hhmm), 20);
      if (when.getTime() > now.getTime()) when = new Date(now.getTime() - Math.round(rand() * 3_600_000));
      if (when.getTime() < s.openedAt.getTime()) when = new Date(s.openedAt.getTime() + 15 * 60_000);
      pending.push({
        id: newId(),
        propertyId,
        shiftId: s.id,
        bookingId: id,
        groupId: b.group ? groupIds.get(b.group)! : null,
        kind: 'payment',
        method,
        paymentType: b.special ? 'special' : b.method === 'cash' ? 'cash' : 'cashless',
        amount,
        payer: method === 'invoice' ? 'company' : 'guest',
        companyId: method === 'invoice' ? companyId : null,
        fiscalStatus: method === 'invoice' ? 'not_required' : 'printed',
        fiscalSign: method === 'invoice' ? null : Math.floor(rand() * 1e10).toString(16).toUpperCase(),
        fiscalAt: method === 'invoice' ? null : when,
        createdAt: when,
        createdBy: who(s.admin).id,
      });
    };
    if (b.paid === 'full') {
      if (b.status === 'checked_out') {
        const prepay = method === 'card' || method === 'qr' ? q.nights[0]!.amount : 0;
        if (prepay && b.from - 3 >= -21) await pay(prepay, b.from - 3, '15:00');
        await pay(total - (prepay && b.from - 3 >= -21 ? prepay : 0), b.to, '10:40');
      } else {
        await pay(total, b.from, '14:50');
      }
    } else if (b.paid === 'prepay') {
      await pay(q.nights[0]!.amount, Math.max(b.from - 3, -21) > 0 ? 0 : Math.max(b.from - 3, -21), '16:00');
    } else if (typeof b.paid === 'number') {
      await pay(tenge(b.paid), Math.min(b.from, 0), '15:10');
    }
  }

  // Пример сторно для отчёта «Отмены и скидки»: оплату ошибочно провели дважды.
  const stornoTarget = bookingIdByKey.get('201:-6');
  const stornoPairs: { originalId: string; stornoId: string }[] = [];
  if (stornoTarget) {
    const s = shiftFor(-2);
    const originalId = newId();
    const stornoId = newId();
    const base = { propertyId, shiftId: s.id, bookingId: stornoTarget, kind: 'payment' as const, method: 'card' as const, paymentType: 'cash' as const, amount: tenge(24_000), fiscalStatus: 'printed' as const };
    pending.push({ ...base, id: originalId, createdAt: at(-2, '11:05'), fiscalAt: at(-2, '11:05'), createdBy: who(s.admin).id });
    pending.push({ ...base, id: stornoId, stornoOf: originalId, stornoReason: 'Проведено дважды', createdAt: at(-2, '11:12'), fiscalAt: at(-2, '11:12'), createdBy: who('senior').id });
    stornoPairs.push({ originalId, stornoId });
  }

  // Смены по порядку: открыть, провести оплаты по времени, закрыть Z-отчётом.
  // Сегодняшняя остаётся открытой.
  let carriedCash = tenge(30_000);
  const numberOf = new Map<string, number>();
  for (const [i, s] of shifts.entries()) {
    await db.insert(cashShifts).values({ id: s.id, propertyId, registerId, number: s.number, openedAt: s.openedAt, openedBy: who(s.admin).id, openingCash: carriedCash });
    const own = pending.filter((p) => p.shiftId === s.id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const p of own) {
      paymentNumber += 1;
      numberOf.set(p.id, paymentNumber);
      const stornoOfNumber = p.stornoOf ? numberOf.get(p.stornoOf) : undefined;
      await db.insert(payments).values({
        ...p,
        number: paymentNumber,
        fiscalNumber: p.fiscalStatus === 'printed' ? `TEST-${String(paymentNumber).padStart(6, '0')}` : null,
        comment: stornoOfNumber ? `Сторно документа ${stornoOfNumber}` : (p.comment ?? null),
      });
    }
    for (const pair of stornoPairs) {
      if (own.some((p) => p.id === pair.stornoId)) {
        await db.update(payments).set({ reversedBy: pair.stornoId }).where(eq(payments.id, pair.originalId));
      }
    }
    if (s.day === 0) break;

    // Смену закрывают перед открытием следующей. Сид, запущенный до 08:00, открывает
    // сегодняшнюю смену раньше - вчерашняя закрывается до неё, а не в будущем.
    const following = shifts[i + 1];
    const planned = jitter(at(s.day + 1, '08:00'), 4);
    const closedAt = following && planned.getTime() >= following.openedAt.getTime() ? new Date(following.openedAt.getTime() - 2 * 60_000) : planned;
    // Перед сменой выручку сдают бухгалтеру, в кассе остаётся размен.
    {
      const [open] = await db.select().from(cashShifts).where(eq(cashShifts.id, s.id));
      const expectedNow = (await buildReport(db, ctx, open!)).expectedCash;
      const float = tenge(30_000);
      if (expectedNow > float) {
        await db.insert(cashMovements).values({
          id: newId(),
          propertyId,
          shiftId: s.id,
          kind: 'withdrawal',
          amount: expectedNow - float,
          reason: `Выручка сдана бухгалтеру: ${who('accountant').name}`,
          createdAt: new Date(closedAt.getTime() - 20 * 60_000),
          createdBy: who(s.admin).id,
        });
      }
    }
    const [row] = await db.select().from(cashShifts).where(eq(cashShifts.id, s.id));
    const short = s.day === -9 ? tenge(1_000) : 0;
    const expected = (await buildReport(db, ctx, row!, { countedCash: 0, comment: null, closedBy: who(s.admin).name, closedAt })).expectedCash;
    const counted = expected - short;
    const report = await buildReport(db, ctx, row!, {
      countedCash: counted,
      comment: short ? 'Недостача 1000 тенге: ошибка со сдачей, разобрались с гостем' : null,
      closedBy: who(s.admin).name,
      closedAt,
    });
    const next = shifts[i + 1];
    await db
      .update(cashShifts)
      .set({
        status: 'closed',
        closedAt,
        closedBy: who(s.admin).id,
        expectedCash: report.expectedCash,
        countedCash: counted,
        discrepancy: report.discrepancy,
        discrepancyComment: report.discrepancyComment,
        zReport: report,
        handedOverTo: next ? who(next.admin).id : null,
      })
      .where(eq(cashShifts.id, s.id));
    if (next) await db.update(cashShifts).set({ acceptedBy: who(next.admin).id, acceptedAt: closedAt }).where(eq(cashShifts.id, s.id));
    carriedCash = counted;
  }

  await db.insert(counters).values([
    { propertyId, name: 'booking', value: bookingNumber },
    { propertyId, name: 'payment', value: paymentNumber },
    { propertyId, name: 'shift', value: shiftNumber },
  ]);

  // ── Ремонт и блокировка ─────────────────────────────────────────────────
  let maintenanceNumber = 0;
  const maintenance = async (number: string | null, row: Omit<typeof maintenanceRequests.$inferInsert, 'id' | 'propertyId' | 'number' | 'roomId'>) => {
    if (number && !roomIds.has(number)) return null;
    const id = newId();
    maintenanceNumber += 1;
    await db.insert(maintenanceRequests).values({ id, propertyId, number: maintenanceNumber, roomId: number ? roomIds.get(number)!.id : null, ...row });
    return { id, number: maintenanceNumber };
  };
  const leak = await maintenance('108', {
    title: 'Течёт смеситель в душе, вода на полу',
    description: 'Гость сообщил при выезде. Под раковиной мокро, нужна замена картриджа.', urgency: 'high',
    status: 'in_progress', assigneeId: who('tech').id, takenAt: at(-1, '10:20'), createdAt: at(-1, '09:40'), createdBy: who('maid2').id,
  });
  if (leak) {
    const blockId = newId();
    await db.insert(roomBlocks).values({
      id: blockId, propertyId, roomId: roomIds.get('108')!.id, startsOn: addDays(T, -1), endsOn: addDays(T, 2),
      reason: `Ремонт: течёт смеситель в душе (заявка ${leak.number})`, maintenanceRequestId: leak.id, createdBy: who('supervisor').id, createdAt: at(-1, '09:50'),
    });
    await db.update(maintenanceRequests).set({ blockId }).where(eq(maintenanceRequests.id, leak.id));
  }
  await maintenance('201', {
    title: 'Не работает пульт от телевизора', urgency: 'low', status: 'open', createdAt: past(at(0, '09:15')), createdBy: who('maid').id,
  });
  await maintenance(null, {
    location: 'Коридор второго этажа', title: 'Перегорела лампа у лестницы', urgency: 'normal',
    status: 'done', assigneeId: who('tech').id, takenAt: at(-3, '11:00'), closedAt: at(-3, '11:40'), closedBy: who('tech').id,
    closeComment: 'Заменил лампу на светодиодную, проверил выключатель', createdAt: at(-3, '10:30'), createdBy: who('supervisor').id,
  });
  await maintenance('106', {
    title: 'Плановое обслуживание кондиционера', urgency: 'normal', status: 'open',
    description: 'Чистка фильтров перед зимним сезоном', createdAt: at(-1, '17:30'), createdBy: who('supervisor').id,
  });
  await db.insert(counters).values({ propertyId, name: 'maintenance', value: maintenanceNumber });

  // ── Состояние номеров и задачи хозслужбы на сегодня ────────────────────
  // Сценарные номера получают заданное состояние; остальные - по занятости.
  const hk: Record<string, (typeof rooms.$inferSelect)['hkStatus']> = {
    '101': 'inspected', '102': 'inspected', '103': 'cleaning', '104': 'dirty', '105': 'dirty',
    '106': 'clean', '107': 'dirty', '108': 'repair', '201': 'inspected', '202': 'clean', '203': 'inspected',
  };
  for (const number of extraRooms) {
    const inHouse = planned.some((b) => b.room === number && b.status === 'checked_in');
    hk[number] = inHouse ? 'dirty' : 'inspected';
  }
  for (const [number, status] of Object.entries(hk)) {
    const room = roomIds.get(number);
    if (!room) continue;
    await db.update(rooms).set({ hkStatus: status, hkStatusAt: past(jitter(at(0, '11:00'), 90)) }).where(eq(rooms.id, room.id));
  }
  const task = async (number: string, kind: 'departure' | 'stayover' | 'general', status: 'open' | 'in_progress' | 'done' | 'inspected', maid: string, extra: Partial<typeof hkTasks.$inferInsert> = {}) => {
    if (!roomIds.has(number)) return;
    const due = kind === 'departure' ? at(0, '14:00') : at(0, SETTINGS.dailyCleaningDue);
    await db.insert(hkTasks).values({
      id: newId(),
      propertyId,
      roomId: roomIds.get(number)!.id,
      kind,
      status,
      businessDate: T,
      assigneeId: who(maid).id,
      dueAt: due,
      checklist: kind === 'departure' ? DEPARTURE_CHECKLIST.map((text) => ({ text, done: status !== 'open' })) : kind === 'general' ? GENERAL_CHECKLIST.map((text) => ({ text, done: false })) : [],
      startedAt: status !== 'open' ? past(at(0, '10:30')) : null,
      finishedAt: status === 'done' || status === 'inspected' ? past(at(0, '11:15')) : null,
      inspectedAt: status === 'inspected' ? past(at(0, '11:40')) : null,
      inspectedBy: status === 'inspected' ? who('supervisor').id : null,
      createdAt: past(at(0, '06:00')),
      ...extra,
    });
  };
  await task('103', 'stayover', 'in_progress', 'maid');
  await task('106', 'stayover', 'done', 'maid');
  await task('107', 'stayover', 'open', 'maid3', { note: 'Гость просил убрать после обеда' });
  await task('201', 'stayover', 'inspected', 'maid2');
  await task('105', 'departure', 'open', 'maid2', { note: 'Выезд утром, заезд сегодня - в первую очередь' });
  await task('202', 'departure', 'done', 'maid3');
  await task('203', 'departure', 'inspected', 'maid');
  const maids = ['maid', 'maid2', 'maid3'];
  for (const [i, number] of extraRooms.entries()) {
    if (planned.some((b) => b.room === number && b.status === 'checked_in')) await task(number, 'stayover', 'open', maids[i % maids.length]!);
  }
  if (isoWeekday(T) === SETTINGS.generalCleaningWeekday) await task('101', 'general', 'open', 'maid3');
  await db.insert(counters).values({ propertyId, name: 'hk-day', value: Number(T.replaceAll('-', '')) });

  // ── Отметки прихода за 10 дней и сегодня ────────────────────────────────
  const events: (typeof attendanceEvents.$inferInsert)[] = [];
  const mark = (login: string, kind: 'in' | 'out', when: Date, method: 'pin' | 'self' = 'pin') =>
    events.push({ id: newId(), propertyId, userId: who(login).id, kind, at: when, method, device: method === 'pin' ? 'kiosk' : null, createdBy: who(login).id });
  for (let d = -10; d <= 0; d++) {
    const weekday = isoWeekday(addDays(T, d));
    const s = shiftFor(d);
    mark(s.admin, 'in', jitter(at(d, '07:52'), 8));
    if (d < 0) mark(s.admin, 'out', jitter(at(d + 1, '08:10'), 6));
    if (weekday <= 6) {
      for (const login of ['maid', 'maid2', 'supervisor', 'tech']) {
        mark(login, 'in', jitter(at(d, login === 'supervisor' ? '08:30' : '09:00'), 14), login === 'tech' ? 'self' : 'pin');
        if (d < 0) mark(login, 'out', jitter(at(d, '18:00'), 20), login === 'tech' ? 'self' : 'pin');
      }
    }
    if (weekday >= 3) {
      mark('maid3', 'in', jitter(at(d, '09:00'), 10));
      if (d < 0) mark('maid3', 'out', jitter(at(d, '18:00'), 15));
    }
    const cc = d % 2 === 0 ? 'callcenter' : 'callcenter2';
    mark(cc, 'in', jitter(at(d, '09:00'), 6), 'self');
    if (d < 0) mark(cc, 'out', jitter(at(d, '21:00'), 10), 'self');
    if (weekday <= 5) {
      mark('accountant', 'in', jitter(at(d, '09:10'), 12), 'self');
      if (d < 0) mark('accountant', 'out', jitter(at(d, '18:05'), 15), 'self');
    }
    if (weekday <= 5) {
      mark('senior', 'in', jitter(at(d, '09:00'), 10));
      if (d < 0) mark('senior', 'out', jitter(at(d, '19:00'), 30));
    }
  }
  // Отметки «на сегодня» не могут быть в будущем.
  await db.insert(attendanceEvents).values(events.filter((e) => (e.at as Date).getTime() <= now.getTime()));

  // Журнал: запись о создании демо, остальное журнал наберёт по ходу работы.
  await db.insert(auditLog).values({
    orgId,
    propertyId,
    actorId: null,
    actorName: 'Система',
    action: 'system.seed',
    entityType: 'property',
    entityId: propertyId,
    entityLabel: 'Bizdin Auyl',
    changes: { demo: [null, `Демо-данные на ${T}`] },
  });

  log(`Демо готово: операционная дата ${T}, номеров ${roomIds.size}, броней ${planned.length}, гостей ${GUESTS.length + 1}, смен ${shifts.length}.`);
  log(`Вход: логины ${STAFF.map((s) => s.login).join(', ')}; пароль ${DEMO_PASSWORD}; PIN ${DEMO_PIN}.`);
  return { orgId, propertyId };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL не задан');
  const handle = createDb(url, { max: 2 });
  try {
    await seed(handle.db);
  } finally {
    await handle.close();
  }
}
