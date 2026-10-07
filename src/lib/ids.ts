import { v7 } from 'uuid';

/** UUID v7: упорядочен по времени, хорошо ложится в индексы и годится как курсор. */
export const newId = (): string => v7();
