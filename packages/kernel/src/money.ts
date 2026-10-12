// Dinero siempre en céntimos enteros. Nunca float.
export type Cents = number;

export function assertCents(value: number): Cents {
  if (!Number.isSafeInteger(value)) throw new RangeError(`Monto inválido: ${value} (se esperan céntimos enteros)`);
  return value;
}

/** Porcentaje de un monto con redondeo al céntimo más cercano (comisiones). */
export function percentOf(amount: Cents, percent: number): Cents {
  return Math.round((amount * Math.round(percent * 100)) / 10000);
}

export function formatMoney(amount: Cents, currency = "PEN", locale = "es-PE"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount / 100);
}
