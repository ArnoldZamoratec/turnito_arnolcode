import { describe, expect, it } from "vitest";
import {
  isoWeekday,
  localDate,
  mergeIntervals,
  percentOf,
  subtractIntervals,
  uuidv7,
  UUID_RE,
  zonedToUtc,
} from "../src/index.js";

const iso = (ms: number) => new Date(ms).toISOString();

describe("zonedToUtc", () => {
  it("Lima es UTC-5 todo el año", () => {
    expect(iso(zonedToUtc("2026-10-12", "09:00", "America/Lima"))).toBe("2026-10-12T14:00:00.000Z");
    expect(iso(zonedToUtc("2026-01-15", "09:00", "America/Lima"))).toBe("2026-01-15T14:00:00.000Z");
  });

  it("respeta el horario de verano (Nueva York: UTC-5 en invierno, UTC-4 en verano)", () => {
    expect(iso(zonedToUtc("2026-01-15", "09:00", "America/New_York"))).toBe("2026-01-15T14:00:00.000Z");
    expect(iso(zonedToUtc("2026-07-15", "09:00", "America/New_York"))).toBe("2026-07-15T13:00:00.000Z");
  });

  it("una hora inexistente por el salto de verano no rompe", () => {
    expect(Number.isFinite(zonedToUtc("2026-03-08", "02:30", "America/New_York"))).toBe(true);
  });

  it("calcula la fecha de negocio local", () => {
    expect(localDate(Date.parse("2026-10-13T03:00:00Z"), "America/Lima")).toBe("2026-10-12");
  });

  it("calcula el día ISO de la semana", () => {
    expect(isoWeekday("2026-10-12")).toBe(1);
    expect(isoWeekday("2026-10-18")).toBe(7);
  });
});

describe("intervalos", () => {
  it("une solapados y contiguos", () => {
    expect(mergeIntervals([{ start: 5, end: 10 }, { start: 0, end: 5 }, { start: 20, end: 30 }])).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ]);
  });

  it("resta los ocupados", () => {
    expect(subtractIntervals([{ start: 0, end: 100 }], [{ start: 10, end: 20 }, { start: 90, end: 120 }])).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 90 },
    ]);
  });
});

describe("dinero e ids", () => {
  it("calcula porcentajes redondeando al céntimo", () => {
    expect(percentOf(2500, 40)).toBe(1000);
    expect(percentOf(999, 33.33)).toBe(333);
  });

  it("genera uuidv7 válidos y ordenables", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(UUID_RE);
    expect(a[14]).toBe("7");
    expect(a < b).toBe(true);
  });
});
