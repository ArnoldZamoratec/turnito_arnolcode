// Intervalos semiabiertos [start, end) en milisegundos epoch.
export interface Interval {
  start: number;
  end: number;
}

export const overlaps = (a: Interval, b: Interval): boolean => a.start < b.end && b.start < a.end;

/** Une intervalos solapados o contiguos; devuelve una lista ordenada. */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

/** Tramos de `base` que no cubre ningún intervalo de `busy`. */
export function subtractIntervals(base: Interval[], busy: Interval[]): Interval[] {
  const blocks = mergeIntervals(busy);
  const out: Interval[] = [];
  for (const b of mergeIntervals(base)) {
    let cursor = b.start;
    for (const x of blocks) {
      if (x.end <= cursor || x.start >= b.end) continue;
      if (x.start > cursor) out.push({ start: cursor, end: x.start });
      cursor = Math.max(cursor, x.end);
      if (cursor >= b.end) break;
    }
    if (cursor < b.end) out.push({ start: cursor, end: b.end });
  }
  return out;
}
