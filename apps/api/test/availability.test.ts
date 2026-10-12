import { describe, expect, it } from "vitest";
import {
  computeAvailability,
  pickLeastLoaded,
  staffSlotStarts,
  type StaffAgenda,
  workingIntervals,
} from "../src/modules/agenda/domain/availability.js";

const TZ = "America/Lima";
const MON = "2026-10-12"; // lunes
const at = (hhmm: string, date = MON) => Date.parse(`${date}T${hhmm}:00-05:00`);
const hhmm = (iso: string) =>
  new Date(Date.parse(iso) - 5 * 3600_000).toISOString().slice(11, 16);

const lucho = (over: Partial<StaffAgenda> = {}): StaffAgenda => ({
  staffId: "lucho",
  occupiedMin: 30,
  weekly: [
    { weekday: 1, startLocal: "09:00", endLocal: "13:00", validFrom: "2026-01-01", validTo: null },
    { weekday: 1, startLocal: "14:00", endLocal: "18:00", validFrom: "2026-01-01", validTo: null },
  ],
  overrides: [],
  busy: [],
  ...over,
});

const query = { date: MON, timeZone: TZ, stepMin: 30, now: at("00:00"), minLeadMin: 0 };

describe("workingIntervals", () => {
  it("usa la plantilla semanal del día", () => {
    expect(workingIntervals(MON, TZ, lucho().weekly, [])).toEqual([
      { start: at("09:00"), end: at("13:00") },
      { start: at("14:00"), end: at("18:00") },
    ]);
  });

  it("un día libre anula la plantilla", () => {
    expect(workingIntervals(MON, TZ, lucho().weekly, [{ isOff: true, startLocal: null, endLocal: null }])).toEqual([]);
  });

  it("un horario especial reemplaza la plantilla", () => {
    expect(workingIntervals(MON, TZ, lucho().weekly, [{ isOff: false, startLocal: "10:00", endLocal: "12:00" }])).toEqual([
      { start: at("10:00"), end: at("12:00") },
    ]);
  });

  it("respeta la vigencia de la plantilla", () => {
    const weekly = [{ weekday: 1, startLocal: "09:00", endLocal: "10:00", validFrom: "2026-11-01", validTo: null }];
    expect(workingIntervals(MON, TZ, weekly, [])).toEqual([]);
  });
});

describe("staffSlotStarts", () => {
  it("genera horarios cada 30 min sin cruzar el almuerzo", () => {
    const slots = staffSlotStarts(lucho(), query).map((t) => hhmm(new Date(t).toISOString()));
    expect(slots).toContain("09:00");
    expect(slots).toContain("12:30");
    expect(slots).not.toContain("13:00");
    expect(slots).toContain("17:30");
    expect(slots).toHaveLength(16);
  });

  it("excluye ocupaciones y no deja empezar un servicio que no cabe", () => {
    const s = lucho({ occupiedMin: 60, busy: [{ start: at("10:00"), end: at("10:30") }] });
    const slots = staffSlotStarts(s, query).map((t) => hhmm(new Date(t).toISOString()));
    expect(slots.slice(0, 3)).toEqual(["09:00", "10:30", "11:00"]);
    expect(slots).not.toContain("09:30"); // 09:30 + 60 min choca con 10:00
    expect(slots).not.toContain("12:30"); // terminaría 13:30, fuera de turno
  });

  it("respeta la anticipación mínima y alinea a la grilla", () => {
    const slots = staffSlotStarts(lucho(), { ...query, now: at("09:07"), minLeadMin: 60 });
    expect(hhmm(new Date(slots[0]!).toISOString())).toBe("10:30");
  });
});

describe("computeAvailability", () => {
  it("combina estilistas por horario", () => {
    const ana = lucho({ staffId: "ana", busy: [{ start: at("09:00"), end: at("12:00") }] });
    const slots = computeAvailability([lucho(), ana], query);
    expect(slots[0]).toEqual({ start: new Date(at("09:00")).toISOString(), staffIds: ["lucho"] });
    const noon = slots.find((s) => hhmm(s.start) === "12:00");
    expect(noon?.staffIds).toEqual(["lucho", "ana"]);
  });

  it("asigna al estilista menos cargado", () => {
    const busyLucho = lucho({ busy: [{ start: at("15:00"), end: at("17:00") }] });
    const ana = lucho({ staffId: "ana", busy: [{ start: at("15:00"), end: at("15:30") }] });
    expect(pickLeastLoaded(["lucho", "ana"], [busyLucho, ana])).toBe("ana");
  });
});
