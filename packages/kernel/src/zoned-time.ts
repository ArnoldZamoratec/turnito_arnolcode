// Conversión entre la hora local de una sucursal (zona IANA) e instantes UTC.
// Sin dependencias: Intl trae la base de datos de zonas horarias.
// No asume ausencia de horario de verano: Perú no lo tiene hoy; México, Chile y Paraguay sí lo han tenido.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function toLocalParts(instantMs: number, timeZone: string): LocalParts {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(new Date(instantMs))
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Desfase de la zona en ese instante, en minutos (Lima: -300). */
export function offsetMinutes(instantMs: number, timeZone: string): number {
  const p = toLocalParts(instantMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / 60000);
}

/**
 * Instante UTC de una fecha y hora local ("2026-10-12", "09:30") en una zona.
 * Hora inexistente (salto de verano): se usa el desfase posterior.
 * Hora ambigua (retroceso): se elige la primera ocurrencia.
 */
export function zonedToUtc(date: string, time: string, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm, ss = 0] = time.split(":").map(Number) as [number, number, number?];
  const naive = Date.UTC(y, m - 1, d, hh, mm, ss);
  const first = naive - offsetMinutes(naive, timeZone) * 60000;
  const second = naive - offsetMinutes(first, timeZone) * 60000;
  return Math.min(first, second);
}

/** Fecha local (YYYY-MM-DD) de un instante en una zona: la "fecha de negocio". */
export function localDate(instantMs: number, timeZone: string): string {
  const p = toLocalParts(instantMs, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Hora local HH:MM de un instante en una zona. */
export function localTime(instantMs: number, timeZone: string): string {
  const p = toLocalParts(instantMs, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** Día ISO de la semana (1 = lunes ... 7 = domingo) de una fecha calendario. */
export function isoWeekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}
