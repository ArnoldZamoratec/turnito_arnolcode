// Casos de uso de la agenda: disponibilidad, reservar, cancelar y bloqueos.
// Todas las funciones reciben una transacción ya abierta con el tenant fijado (RLS).
import { EXCLUSION_VIOLATION, pgErrorCode, type Tx } from "@salon/db";
import { addDays, type Interval, uuidv7, zonedToUtc } from "@salon/kernel";
import { config } from "../../config.js";
import { DomainError, conflict, invalid, notFound } from "../../platform/errors.js";
import { emit } from "../../platform/outbox.js";
import {
  computeAvailability,
  pickLeastLoaded,
  type Slot,
  type StaffAgenda,
  workingIntervals,
} from "./domain/availability.js";

const MIN = 60_000;

export interface BranchInfo {
  id: string;
  timezone: string;
  slotStepMin: number;
  cancelMinHours: number;
}

export interface ServiceInfo {
  id: string;
  name: string;
  durationMin: number;
  bufferAfterMin: number;
  priceCents: number;
  bookableOnline: boolean;
}

export interface DayAgenda {
  branch: BranchInfo;
  service: ServiceInfo;
  staff: (StaffAgenda & { priceCents: number; durationMin: number })[];
}

export class SlotTakenError extends DomainError {
  constructor() {
    super("SLOT_TAKEN", 409, "Ese horario acaba de ocuparse. Elige otro.");
  }
}

export async function loadBranch(tx: Tx, branchId: string): Promise<BranchInfo> {
  const { rows } = await tx.query<BranchInfo>(
    `SELECT id, timezone, slot_step_min AS "slotStepMin", cancel_min_hours AS "cancelMinHours"
     FROM core.branches WHERE id = $1 AND deleted_at IS NULL`,
    [branchId],
  );
  if (!rows[0]) throw notFound("La sucursal");
  return rows[0];
}

async function loadService(tx: Tx, serviceId: string): Promise<ServiceInfo> {
  const { rows } = await tx.query<ServiceInfo>(
    `SELECT id, name, duration_min AS "durationMin", buffer_after_min AS "bufferAfterMin",
            price_cents AS "priceCents", bookable_online AS "bookableOnline"
     FROM catalog.services WHERE id = $1 AND active AND deleted_at IS NULL`,
    [serviceId],
  );
  if (!rows[0]) throw notFound("El servicio");
  return rows[0];
}

/** Arma la agenda del día de los estilistas que pueden hacer el servicio. */
export async function loadDayAgenda(
  tx: Tx,
  q: { branchId: string; serviceId: string; date: string; staffId?: string; onlineOnly?: boolean },
): Promise<DayAgenda> {
  const branch = await loadBranch(tx, q.branchId);
  const service = await loadService(tx, q.serviceId);
  if (q.onlineOnly && !service.bookableOnline) throw notFound("El servicio");

  const staffRows = (
    await tx.query<{ id: string; durationMin: number | null; priceCents: number | null }>(
      `SELECT st.id, ss.duration_override_min AS "durationMin", ss.price_override_cents AS "priceCents"
       FROM agenda.staff st
       JOIN agenda.staff_services ss ON ss.staff_id = st.id AND ss.service_id = $2
       WHERE st.branch_id = $1 AND st.active AND st.deleted_at IS NULL
         AND ($3::uuid IS NULL OR st.id = $3::uuid)
         AND (NOT $4::boolean OR st.bookable_online)
       ORDER BY st.display_name`,
      [q.branchId, q.serviceId, q.staffId ?? null, q.onlineOnly ?? false],
    )
  ).rows;
  if (q.staffId && staffRows.length === 0) {
    // Inactivo o sin reservas online: simplemente no tiene horarios. Activo pero sin el servicio: error claro.
    const active = await tx.query("SELECT 1 FROM agenda.staff WHERE id = $1 AND active AND deleted_at IS NULL", [q.staffId]);
    if (active.rowCount && !q.onlineOnly) throw invalid("Ese estilista no realiza este servicio");
  }
  const ids = staffRows.map((s) => s.id);

  const dayStart = zonedToUtc(q.date, "00:00", branch.timezone);
  const dayEnd = zonedToUtc(addDays(q.date, 1), "00:00", branch.timezone);

  const weekly = (
    await tx.query<{ staffId: string; weekday: number; startLocal: string; endLocal: string; validFrom: string; validTo: string | null }>(
      `SELECT staff_id AS "staffId", weekday, to_char(start_local, 'HH24:MI') AS "startLocal",
              to_char(end_local, 'HH24:MI') AS "endLocal", valid_from AS "validFrom", valid_to AS "validTo"
       FROM agenda.working_hours WHERE staff_id = ANY($1::uuid[])`,
      [ids],
    )
  ).rows;
  const overrides = (
    await tx.query<{ staffId: string; isOff: boolean; startLocal: string | null; endLocal: string | null }>(
      `SELECT staff_id AS "staffId", is_off AS "isOff", to_char(start_local, 'HH24:MI') AS "startLocal",
              to_char(end_local, 'HH24:MI') AS "endLocal"
       FROM agenda.staff_day_overrides WHERE staff_id = ANY($1::uuid[]) AND on_date = $2`,
      [ids, q.date],
    )
  ).rows;
  const busy = (
    await tx.query<{ staffId: string; start: string; end: string }>(
      `SELECT staff_id AS "staffId", lower(period) AS "start", upper(period) AS "end"
       FROM agenda.staff_bookings
       WHERE staff_id = ANY($1::uuid[]) AND active AND period && tstzrange($2, $3, '[)')
         AND (kind <> 'hold' OR expires_at > now())`,
      [ids, new Date(dayStart).toISOString(), new Date(dayEnd).toISOString()],
    )
  ).rows;

  return {
    branch,
    service,
    staff: staffRows.map((s) => {
      const durationMin = s.durationMin ?? service.durationMin;
      return {
        staffId: s.id,
        durationMin,
        priceCents: s.priceCents ?? service.priceCents,
        occupiedMin: durationMin + service.bufferAfterMin,
        weekly: weekly.filter((w) => w.staffId === s.id),
        overrides: overrides.filter((o) => o.staffId === s.id),
        busy: busy.filter((b) => b.staffId === s.id).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })),
      };
    }),
  };
}

export function availabilityFor(day: DayAgenda, date: string, minLeadMin: number, now = Date.now()): Slot[] {
  return computeAvailability(day.staff, {
    date,
    timeZone: day.branch.timezone,
    stepMin: day.branch.slotStepMin,
    now,
    minLeadMin,
  });
}

export interface BookInput {
  id?: string;
  branchId: string;
  serviceId: string;
  staffId?: string;
  startsAt: string; // ISO
  clientId: string | null;
  source: "reception" | "public" | "walk_in" | "offline";
  notes?: string | null;
  createdBy: string | null;
  /** Recepción puede agendar fuera del horario (el estilista se queda más tarde). La reserva pública nunca. */
  allowOutsideHours: boolean;
  /** Hold de la reserva pública: ocupa el espacio unos minutos mientras la clienta completa sus datos. */
  hold?: boolean;
}

export interface BookedAppointment {
  id: string;
  status: string;
  branchId: string;
  staffId: string;
  serviceId: string;
  clientId: string | null;
  startsAt: string;
  endsAt: string;
  priceCents: number;
  holdExpiresAt: string | null;
}

/** Fecha local del instante en la zona de la sucursal. */
function localDateOf(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

/**
 * Reserva un horario. La garantía de no solapamiento la da el constraint EXCLUDE de la BD (I1);
 * aquí solo se valida el horario laboral (I2) y la habilitación del estilista (I4).
 */
export async function book(tx: Tx, tenantId: string, input: BookInput): Promise<BookedAppointment> {
  const start = Date.parse(input.startsAt);
  if (!Number.isFinite(start)) throw invalid("Fecha y hora inválidas");
  const branch = await loadBranch(tx, input.branchId);
  const date = localDateOf(start, branch.timezone);
  const day = await loadDayAgenda(tx, {
    branchId: input.branchId,
    serviceId: input.serviceId,
    date,
    staffId: input.staffId,
    onlineOnly: input.source === "public",
  });
  if (day.staff.length === 0) throw invalid("Ningún estilista de esta sucursal realiza este servicio");

  const slotOf = (s: DayAgenda["staff"][number]): Interval => ({ start, end: start + s.occupiedMin * MIN });
  const inHours = (s: DayAgenda["staff"][number]) =>
    input.allowOutsideHours ||
    workingIntervals(date, branch.timezone, s.weekly, s.overrides).some((w) => w.start <= slotOf(s).start && slotOf(s).end <= w.end);
  const isFree = (s: DayAgenda["staff"][number]) => !s.busy.some((b) => b.start < slotOf(s).end && slotOf(s).start < b.end);
  const fits = (s: DayAgenda["staff"][number]) => inHours(s) && isFree(s);

  let staff = day.staff[0]!;
  if (input.staffId) {
    if (!inHours(staff)) throw invalid("El horario está fuera del turno del estilista");
    if (!isFree(staff)) throw new SlotTakenError();
  } else {
    const candidates = day.staff.filter(fits).map((s) => s.staffId);
    const chosen = pickLeastLoaded(candidates, day.staff);
    if (!chosen) throw new SlotTakenError();
    staff = day.staff.find((s) => s.staffId === chosen)!;
  }

  const id = input.id ?? uuidv7();
  const endsAt = new Date(start + staff.durationMin * MIN).toISOString();
  const occupiedEnd = new Date(start + staff.occupiedMin * MIN).toISOString();
  const holdExpiresAt = input.hold ? new Date(Date.now() + config.holdMinutes * MIN).toISOString() : null;
  const status = input.hold ? "held" : "confirmed";

  // Libera holds vencidos del estilista antes de competir por el espacio.
  await tx.query(
    "UPDATE agenda.staff_bookings SET active = false WHERE staff_id = $1 AND kind = 'hold' AND active AND expires_at <= now()",
    [staff.staffId],
  );

  await tx.query("SAVEPOINT book");
  try {
    await tx.query(
      `INSERT INTO agenda.appointments (id, tenant_id, branch_id, client_id, status, source, starts_at, ends_at, hold_expires_at, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, tenantId, input.branchId, input.clientId, status, input.source, new Date(start).toISOString(), endsAt, holdExpiresAt,
        input.notes ?? null, input.createdBy],
    );
    await tx.query(
      `INSERT INTO agenda.staff_bookings (id, tenant_id, branch_id, staff_id, kind, appointment_id, service_id, period, price_cents, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, tstzrange($8, $9, '[)'), $10, $11)`,
      [uuidv7(), tenantId, input.branchId, staff.staffId, input.hold ? "hold" : "service", id, input.serviceId,
        new Date(start).toISOString(), occupiedEnd, staff.priceCents, holdExpiresAt],
    );
    await tx.query("RELEASE SAVEPOINT book");
  } catch (err) {
    await tx.query("ROLLBACK TO SAVEPOINT book");
    if (pgErrorCode(err) === EXCLUSION_VIOLATION) throw new SlotTakenError();
    throw err;
  }

  if (!input.hold) {
    await emit(tx, tenantId, "agenda.AppointmentConfirmed.v1", { appointmentId: id, startsAt: new Date(start).toISOString() });
  }
  return {
    id,
    status,
    branchId: input.branchId,
    staffId: staff.staffId,
    serviceId: input.serviceId,
    clientId: input.clientId,
    startsAt: new Date(start).toISOString(),
    endsAt,
    priceCents: staff.priceCents,
    holdExpiresAt,
  };
}

/** Convierte un hold vigente en cita confirmada. */
export async function confirmHold(tx: Tx, tenantId: string, appointmentId: string, clientId: string): Promise<void> {
  const { rows } = await tx.query<{ status: string; expired: boolean }>(
    `SELECT a.status, (a.hold_expires_at <= now()) AS expired FROM agenda.appointments a WHERE a.id = $1 FOR UPDATE`,
    [appointmentId],
  );
  const appt = rows[0];
  if (!appt) throw notFound("La reserva");
  if (appt.status === "confirmed") return; // reintento idempotente
  if (appt.status !== "held") throw conflict("HOLD_INVALID", "Esta reserva ya no está disponible");

  if (appt.expired) {
    // El hold venció, pero si nadie tomó el espacio se puede rescatar reactivándolo.
    await tx.query("SAVEPOINT revive");
    try {
      await tx.query(
        "UPDATE agenda.staff_bookings SET active = true, expires_at = now() + interval '1 minute' WHERE appointment_id = $1 AND kind = 'hold'",
        [appointmentId],
      );
      await tx.query("RELEASE SAVEPOINT revive");
    } catch (err) {
      await tx.query("ROLLBACK TO SAVEPOINT revive");
      if (pgErrorCode(err) === EXCLUSION_VIOLATION) {
        await tx.query("UPDATE agenda.appointments SET status = 'cancelled', cancelled_by = 'system', cancel_reason = 'hold vencido' WHERE id = $1", [appointmentId]);
        throw new SlotTakenError();
      }
      throw err;
    }
  }
  await tx.query(
    "UPDATE agenda.staff_bookings SET kind = 'service', expires_at = NULL, active = true WHERE appointment_id = $1 AND kind = 'hold'",
    [appointmentId],
  );
  await tx.query(
    "UPDATE agenda.appointments SET status = 'confirmed', hold_expires_at = NULL, client_id = $2 WHERE id = $1",
    [appointmentId, clientId],
  );
  const startsAt = (await tx.query<{ s: string }>("SELECT starts_at AS s FROM agenda.appointments WHERE id = $1", [appointmentId])).rows[0]!.s;
  await emit(tx, tenantId, "agenda.AppointmentConfirmed.v1", { appointmentId, startsAt });
}

const TRANSITIONS: Record<string, string[]> = {
  confirmed: ["checked_in", "completed", "cancelled", "no_show"],
  checked_in: ["completed", "cancelled"],
  conflict: ["confirmed", "cancelled"],
  held: ["cancelled"],
};

/** Cambia el estado respetando las transiciones válidas (I3). Cancelar libera el espacio en la misma transacción. */
export async function changeStatus(
  tx: Tx,
  tenantId: string,
  appointmentId: string,
  to: "checked_in" | "completed" | "cancelled" | "no_show",
  meta: { by?: "client" | "staff" | "system"; reason?: string | null } = {},
): Promise<{ id: string; status: string; lateCancellation: boolean }> {
  const { rows } = await tx.query<{ status: string; startsAt: string; clientId: string | null; cancelMinHours: number }>(
    `SELECT a.status, a.starts_at AS "startsAt", a.client_id AS "clientId", b.cancel_min_hours AS "cancelMinHours"
     FROM agenda.appointments a JOIN core.branches b ON b.id = a.branch_id
     WHERE a.id = $1 FOR UPDATE OF a`,
    [appointmentId],
  );
  const appt = rows[0];
  if (!appt) throw notFound("La cita");
  if (appt.status === to) return { id: appointmentId, status: to, lateCancellation: false };
  if (!TRANSITIONS[appt.status]?.includes(to)) {
    throw conflict("INVALID_TRANSITION", `No se puede pasar de "${appt.status}" a "${to}"`);
  }

  let lateCancellation = false;
  if (to === "cancelled") {
    lateCancellation = Date.parse(appt.startsAt) - Date.now() < appt.cancelMinHours * 3_600_000;
    await tx.query("UPDATE agenda.staff_bookings SET active = false WHERE appointment_id = $1", [appointmentId]);
    await tx.query(
      "UPDATE agenda.appointments SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1",
      [appointmentId, meta.by ?? "staff", meta.reason ?? null],
    );
    await emit(tx, tenantId, "agenda.AppointmentCancelled.v1", { appointmentId, lateCancellation });
  } else {
    await tx.query("UPDATE agenda.appointments SET status = $2 WHERE id = $1", [appointmentId, to]);
    if (to === "no_show") {
      // La ausencia libera el resto del bloque (por si llega un walk-in) y cuenta en la ficha.
      await tx.query("UPDATE agenda.staff_bookings SET active = false WHERE appointment_id = $1", [appointmentId]);
      if (appt.clientId) await tx.query("UPDATE crm.clients SET no_show_count = no_show_count + 1 WHERE id = $1", [appt.clientId]);
    }
    await emit(tx, tenantId, `agenda.Appointment${to === "completed" ? "Completed" : to === "no_show" ? "NoShow" : "CheckedIn"}.v1`, { appointmentId });
  }
  return { id: appointmentId, status: to, lateCancellation };
}
