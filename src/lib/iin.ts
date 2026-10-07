/**
 * ИИН (физлица) и БИН (юрлица) Казахстана - 12 цифр, последняя контрольная.
 * Контрольная цифра: сумма первых 11 цифр с весами 1..11 по модулю 11; если
 * вышло 10 - вторая попытка с весами 3..11, 1, 2; если снова 10, такой номер
 * не выдаётся. Проверка ловит опечатку в одной цифре и перестановку соседних.
 */

const WEIGHTS_1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const WEIGHTS_2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];

/** Контрольная цифра для первых 11 цифр или null, если номер с таким началом не выдаётся. */
export function iinControlDigit(first11: string): number | null {
  if (!/^\d{11}$/.test(first11)) return null;
  const digits = [...first11].map(Number);
  const weighted = (weights: number[]) => digits.reduce((acc, d, i) => acc + d * weights[i]!, 0) % 11;
  const first = weighted(WEIGHTS_1);
  if (first !== 10) return first;
  const second = weighted(WEIGHTS_2);
  return second === 10 ? null : second;
}

/** 12 цифр и сходится контрольная. Подходит и для ИИН, и для БИН. */
export function isValidIin(value: string): boolean {
  if (!/^\d{12}$/.test(value)) return false;
  return iinControlDigit(value.slice(0, 11)) === Number(value[11]);
}

/**
 * Дата рождения и пол из ИИН. Седьмая цифра - век и пол: 1-2 - XIX век,
 * 3-4 - XX, 5-6 - XXI; нечётная - мужской, чётная - женский.
 */
export function iinPerson(value: string): { birthDate: string; gender: 'm' | 'f' } | null {
  if (!isValidIin(value)) return null;
  const marker = Number(value[6]);
  if (marker < 1 || marker > 6) return null;
  const century = 1700 + Math.ceil(marker / 2) * 100;
  const iso = `${century + Number(value.slice(0, 2))}-${value.slice(2, 4)}-${value.slice(4, 6)}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;
  return { birthDate: iso, gender: marker % 2 === 1 ? 'm' : 'f' };
}
