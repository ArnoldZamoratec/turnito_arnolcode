// Cálculo de disponibilidad: puro, sin BD ni framework. Toda la lógica de horarios vive aquí.
import { type Interval, isoWeekday, subtractIntervals, zonedToUtc } from "@salon/kernel";

export interface WeeklyHours {
  weekday: number; // 1 = lunes ... 7 = domingo
  startLocal: string; // "09:00"
  endLocal: string; // "13:00"
  validFrom: string; // fecha local YYYY-MM-DD
  validTo: string | null;
}

export interface DayOverride {
  isOff: boolean;
  startLocal: string | null;
  endLocal: string | null;
}

export interface StaffAgenda {
  staffId: string;
  /** Minutos que ocupa el servicio con este estilista (duración + margen posterior). */
  occupiedMin: number;
  weekly: WeeklyHours[];
  overrides: DayOverride[]; // solo las de la fecha consultada
  busy: Interval[]; // ocupaciones activas (servicios, bloqueos, holds vigentes)
}

export interface AvailabilityQuery {
  date: string; // fecha local de la sucursal
  timeZone: string;
  stepMin: number;
  now: number;
  minLeadMin: number; // anticipación mínima para reservar
}

export interface Slot {
  start: string; // ISO UTC
  staffIds: string[];
}

const MIN = 60_000;

/** Intervalos de trabajo del estilista en esa fecha, como instantes UTC. */
export function workingIntervals(
  date: string,
  timeZone: string,
  weekly: WeeklyHours[],
  overrides: DayOverride[],
): Interval[] {
  if (overrides.some((o) => o.isOff)) return [];
  const special = overrides.filter((o) => o.startLocal && o.endLocal);
  const local = special.length
    ? special.map((o) => ({ startLocal: o.startLocal!, endLocal: o.endLocal! }))
    : weekly.filter(
        (w) => w.weekday === isoWeekday(date) && w.validFrom <= date && (w.validTo === null || date <= w.validTo),
      );
  return local.map((w) => ({
    start: zonedToUtc(date, w.startLocal, timeZone),
    end: zonedToUtc(date, w.endLocal, timeZone),
  }));
}

/** Inicios posibles para un estilista, alineados a la grilla de la sucursal (cada stepMin desde la medianoche local). */
export function staffSlotStarts(staff: StaffAgenda, q: AvailabilityQuery): number[] {
  const step = q.stepMin * MIN;
  const length = staff.occupiedMin * MIN;
  const dayStart = zonedToUtc(q.date, "00:00", q.timeZone);
  const earliest = q.now + q.minLeadMin * MIN;
  const free = subtractIntervals(workingIntervals(q.date, q.timeZone, staff.weekly, staff.overrides), staff.busy);

  const starts: number[] = [];
  for (const f of free) {
    const from = Math.max(f.start, earliest);
    let t = dayStart + Math.ceil((from - dayStart) / step) * step;
    for (; t + length <= f.end; t += step) starts.push(t);
  }
  return starts;
}

/** Disponibilidad combinada: cada hora con los estilistas que pueden atender en ella. */
export function computeAvailability(staff: StaffAgenda[], q: AvailabilityQuery): Slot[] {
  const byStart = new Map<number, string[]>();
  for (const s of staff) {
    for (const t of staffSlotStarts(s, q)) {
      const list = byStart.get(t) ?? [];
      list.push(s.staffId);
      byStart.set(t, list);
    }
  }
  return [...byStart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, staffIds]) => ({ start: new Date(t).toISOString(), staffIds }));
}

/**
 * "Cualquier estilista": elige al que tiene menos minutos ocupados ese día,
 * para repartir la carga. Empate: orden estable de entrada.
 */
export function pickLeastLoaded(candidates: string[], staff: StaffAgenda[]): string | undefined {
  const load = (id: string) =>
    staff.find((s) => s.staffId === id)?.busy.reduce((acc, i) => acc + (i.end - i.start), 0) ?? Infinity;
  return [...candidates].sort((a, b) => load(a) - load(b))[0];
}
