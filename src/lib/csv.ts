/**
 * CSV для Excel и 1С: BOM, чтобы Excel узнал UTF-8 и не показал кракозябры;
 * разделитель «;» и перевод строки CRLF, как ждёт русская локаль Excel.
 */
export function toCsv(rows: (string | number)[][]): string {
  const BOM = String.fromCharCode(0xfeff);
  return BOM + rows.map((line) => line.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
}

/** Сумма в минимальных единицах как число с запятой: 1250000 -> «12500,00». */
export function csvMoney(minor: number): string {
  return (minor / 100).toFixed(2).replace('.', ',');
}
