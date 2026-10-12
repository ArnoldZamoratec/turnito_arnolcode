import { addDays, formatMoney, localDate, zonedToUtc } from "@salon/kernel";

export const LIMA = "America/Lima";

export const money = (cents: number) => formatMoney(cents, "PEN", "es-PE");

export const timeIn = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("es-PE", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Lunes, 12 de octubre" (solo la primera letra en mayúscula, como se escribe en español). */
export const longDate = (date: string) =>
  upperFirst(
    new Intl.DateTimeFormat("es-PE", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(
      new Date(`${date}T12:00:00Z`),
    ),
  );

export const shortDate = (date: string) =>
  upperFirst(new Intl.DateTimeFormat("es-PE", { weekday: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`)));

export const today = (tz: string) => localDate(Date.now(), tz);

/** Minutos desde la medianoche local de `date` hasta el instante. */
export const minutesFromMidnight = (iso: string, date: string, tz: string) =>
  (Date.parse(iso) - zonedToUtc(date, "00:00", tz)) / 60000;

export const localToIso = (date: string, hhmm: string, tz: string) => new Date(zonedToUtc(date, hhmm, tz)).toISOString();

export const waLink = (phoneE164: string, text: string) =>
  `https://wa.me/${phoneE164.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;

export { addDays };
