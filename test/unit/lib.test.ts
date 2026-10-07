import { describe, expect, it } from 'vitest';
import { addDays, businessDate, diffDays, eachNight, isoWeekday, localDate, monthRange, zonedToUtc } from '../../src/lib/dates.ts';
import { iinControlDigit, iinPerson, isValidIin } from '../../src/lib/iin.ts';
import { applyPercentDiscount } from '../../src/lib/money.ts';
import { checkDigit, parseMrz } from '../../src/lib/mrz.ts';
import { normalizeDocNumber, normalizePhone, shortName } from '../../src/lib/normalize.ts';
import { base32Decode, base32Encode, totpCode, verifyTotp } from '../../src/lib/totp.ts';
import { pickPrice } from '../../src/modules/rates/pricing.ts';

describe('даты гостиницы', () => {
  it('ночи проживания не включают дату выезда', () => {
    expect(eachNight('2026-10-07', '2026-10-10')).toEqual(['2026-10-07', '2026-10-08', '2026-10-09']);
    expect(diffDays('2026-10-07', '2026-10-10')).toBe(3);
  });

  it('переход через месяц и високосный год', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('день недели ISO', () => {
    expect(isoWeekday('2026-10-05')).toBe(1);
    expect(isoWeekday('2026-10-11')).toBe(7);
  });

  it('операционная дата: до 06:00 по Алматы - ещё вчерашние сутки', () => {
    // 2026-10-07 02:30 в Алматы (UTC+5 с 2024 года) = 2026-10-06 21:30 UTC
    const night = new Date('2026-10-06T21:30:00Z');
    expect(localDate(night, 'Asia/Almaty')).toBe('2026-10-07');
    expect(businessDate(night, 'Asia/Almaty')).toBe('2026-10-06');
    const morning = new Date('2026-10-07T02:30:00Z'); // 07:30 в Алматы
    expect(businessDate(morning, 'Asia/Almaty')).toBe('2026-10-07');
  });

  it('местное время гостиницы в UTC', () => {
    expect(zonedToUtc('2026-10-07', '14:00', 'Asia/Almaty').toISOString()).toBe('2026-10-07T09:00:00.000Z');
    // Летнее время в Берлине: смещение учитывается на дату
    expect(zonedToUtc('2026-07-01', '12:00', 'Europe/Berlin').toISOString()).toBe('2026-07-01T10:00:00.000Z');
    expect(zonedToUtc('2026-12-01', '12:00', 'Europe/Berlin').toISOString()).toBe('2026-12-01T11:00:00.000Z');
  });
});

describe('деньги', () => {
  it('скидка округляется до целого тенге, тиынов в кассе нет', () => {
    expect(applyPercentDiscount(2_200_000, 10)).toBe(1_980_000);
    expect(applyPercentDiscount(2_233_300, 7)).toBe(2_077_000);
    expect(applyPercentDiscount(100, 50)).toBe(100);
  });
});

describe('MRZ', () => {
  it('контрольная цифра ICAO 9303', () => {
    expect(checkDigit('L898902C3')).toBe(6);
    expect(checkDigit('740812')).toBe(2);
    expect(checkDigit('120415')).toBe(9);
  });

  it('паспорт TD3 из образца ICAO', () => {
    const r = parseMrz('P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10');
    expect(r).not.toBeNull();
    expect(r!.format).toBe('TD3');
    expect(r!.lastName).toBe('ERIKSSON');
    expect(r!.firstName).toBe('ANNA');
    expect(r!.middleName).toBe('MARIA');
    expect(r!.documentNumber).toBe('L898902C3');
    expect(r!.birthDate).toBe('1974-08-12');
    expect(r!.sex).toBe('f');
    expect(r!.valid).toBe(true);
  });

  it('ID-карта TD1 из образца ICAO', () => {
    const r = parseMrz('I<UTOD231458907<<<<<<<<<<<<<<<\n7408122F1204159UTO<<<<<<<<<<<6\nERIKSSON<<ANNA<MARIA<<<<<<<<<<');
    expect(r).not.toBeNull();
    expect(r!.format).toBe('TD1');
    expect(r!.docType).toBe('id_card');
    expect(r!.documentNumber).toBe('D23145890');
    expect(r!.valid).toBe(true);
  });

  it('удостоверение личности РК: ИИН из опциональных данных', () => {
    const r = parseMrz('IDKAZ0412365878880412401006<<<\n8804123F3104116KAZ<<<<<<<<<<<2\nSEIDAKHMETOVA<<MADINA<<<<<<<<<');
    expect(r!.valid).toBe(true);
    expect(r!.docType).toBe('id_card');
    expect(r!.documentNumber).toBe('041236587');
    expect(r!.personalNumber).toBe('880412401006');
    expect(r!.birthDate).toBe('1988-04-12');
    expect(r!.sex).toBe('f');
  });

  it('опечатка распознавания видна по контрольной цифре', () => {
    const r = parseMrz('P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408132F1204159ZE184226B<<<<<10');
    expect(r!.checks.birthDate).toBe(false);
    expect(r!.valid).toBe(false);
  });

  it('не MRZ - null', () => {
    expect(parseMrz('просто текст')).toBeNull();
  });
});

describe('TOTP (RFC 6238)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  it('base32 туда и обратно', () => {
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
  });

  it('эталонные значения из RFC 6238 (SHA1, 6 цифр)', () => {
    expect(totpCode(secret, 59_000)).toBe('287082');
    expect(totpCode(secret, 1_111_111_109_000)).toBe('081804');
    expect(totpCode(secret, 1_234_567_890_000)).toBe('005924');
  });

  it('допуск на один шаг часов', () => {
    const at = 1_234_567_890_000;
    expect(verifyTotp(secret, totpCode(secret, at - 30_000), at)).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, at - 90_000), at)).toBe(false);
    expect(verifyTotp(secret, 'abcdef', at)).toBe(false);
  });
});

describe('ИИН и БИН', () => {
  it('контрольная цифра: первый проход весами 1..11', () => {
    expect(iinControlDigit('88041240100')).toBe(6);
    expect(isValidIin('880412401006')).toBe(true);
    expect(isValidIin('880412401007')).toBe(false);
  });

  it('второй проход весами 3..11, 1, 2, если первый дал 10', () => {
    expect(iinControlDigit('90010130081')).toBe(1);
    // Оба прохода дали 10: такой номер не выдаётся.
    expect(iinControlDigit('90010130080')).toBeNull();
  });

  it('перестановка соседних цифр ловится', () => {
    expect(isValidIin('880412410006')).toBe(false);
  });

  it('дата рождения и пол из ИИН', () => {
    expect(iinPerson('880412401006')).toEqual({ birthDate: '1988-04-12', gender: 'f' });
    expect(iinPerson('900101300811')).toEqual({ birthDate: '1990-01-01', gender: 'm' });
    expect(iinPerson('880412401007')).toBeNull();
  });

  it('БИН проверяется тем же правилом', () => {
    expect(isValidIin('180440012349')).toBe(true);
    expect(isValidIin('1804400123')).toBe(false);
  });
});

describe('нормализация для поиска дублей', () => {
  it('телефоны Казахстана в одном виде', () => {
    expect(normalizePhone('8 701 123 45 67')).toBe('77011234567');
    expect(normalizePhone('+7 (701) 123-45-67')).toBe('77011234567');
    expect(normalizePhone('701 123 45 67')).toBe('77011234567');
    expect(normalizePhone('+7 7172 57 12 34')).toBe('77172571234');
    expect(normalizePhone('12')).toBeNull();
  });

  it('номер документа без пробелов и знаков', () => {
    expect(normalizeDocNumber('n 0451-2378')).toBe('N04512378');
    expect(normalizeDocNumber('№ 041 236 587')).toBe('041236587');
  });

  it('короткое имя', () => {
    expect(shortName({ lastName: 'Сейдахметова', firstName: 'Мадина', middleName: 'Маратовна' })).toBe('Сейдахметова М. М.');
    expect(shortName({ lastName: 'Нұрланұлы', firstName: 'Әлихан' })).toBe('Нұрланұлы Ә.');
  });
});

describe('цена ночи по тарифу', () => {
  const base = { id: 'x', propertyId: 'p', ratePlanId: 'r', roomTypeId: 't', createdAt: new Date('2026-01-01') };
  const rows = [
    { ...base, id: 'all', label: 'Базовая', validFrom: '2026-01-01', validTo: '2026-12-31', weekdays: [1, 2, 3, 4, 5, 6, 7], amount: 2_200_000, priority: 0 },
    { ...base, id: 'wknd', label: 'Выходные', validFrom: '2026-01-01', validTo: '2026-12-31', weekdays: [5, 6], amount: 2_500_000, priority: 5 },
    { ...base, id: 'summer', label: 'Сезон', validFrom: '2026-06-15', validTo: '2026-08-31', weekdays: [1, 2, 3, 4, 5, 6, 7], amount: 3_200_000, priority: 10 },
  ];

  it('будний день - базовая', () => expect(pickPrice(rows, '2026-10-07')!.id).toBe('all'));
  it('пятница - выходные', () => expect(pickPrice(rows, '2026-10-09')!.id).toBe('wknd'));
  it('сезон перекрывает выходные', () => expect(pickPrice(rows, '2026-07-10')!.id).toBe('summer'));
  it('вне периода - нет цены', () => expect(pickPrice(rows, '2027-01-05')).toBeNull());
});
