import { randomBytes } from 'node:crypto';

export type FiscalReceipt = {
  paymentNumber: number;
  operation: 'sale' | 'refund';
  method: string;
  amount: number;
  currency: string;
  description: string;
};

export type FiscalResult =
  | { status: 'printed'; fiscalNumber: string; fiscalSign: string; at: Date }
  | { status: 'failed'; error: string; at: Date };

/**
 * Фискальная касса (онлайн-ККМ). Каждая оплата наличными, картой и по QR
 * пробивается чеком; онлайн-ККМ передаёт его оператору фискальных данных (ОФД).
 * Какая касса и чьи требования к фискализации - в ТЗ помечено «уточнить»,
 * поэтому за интерфейсом пока тестовый драйвер: он выдаёт номер «TEST-…», и
 * в интерфейсе такой чек подписан как тестовый.
 */
export interface FiscalDriver {
  readonly name: string;
  readonly isTest: boolean;
  register(receipt: FiscalReceipt): Promise<FiscalResult>;
}

export class MockFiscalDriver implements FiscalDriver {
  readonly name = 'mock';
  readonly isTest = true;

  async register(receipt: FiscalReceipt): Promise<FiscalResult> {
    return {
      status: 'printed',
      fiscalNumber: `TEST-${String(receipt.paymentNumber).padStart(6, '0')}`,
      fiscalSign: randomBytes(5).toString('hex').toUpperCase(),
      at: new Date(),
    };
  }
}
