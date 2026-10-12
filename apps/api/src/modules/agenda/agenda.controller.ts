import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Post, Query, Res } from "@nestjs/common";
import { EXCLUSION_VIOLATION, pgErrorCode, withTenant } from "@salon/db";
import { addDays, uuidv7, zonedToUtc } from "@salon/kernel";
import type { FastifyReply } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { PG_POOL } from "../../platform/database.js";
import { conflict, DomainError, notFound } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { emit } from "../../platform/outbox.js";
import { assertBranchAccess, Ctx, InTenant, type TenantContext } from "../../platform/tenancy.js";
import { ClientInput, upsertClientByPhone } from "../crm/clients.js";
import { availabilityFor, book, changeStatus, loadBranch, loadDayAgenda, SlotTakenError } from "./booking.service.js";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Usa formato AAAA-MM-DD");

const AvailabilityQuery = z.object({
  serviceId: z.uuid(),
  date: DATE,
  staffId: z.uuid().optional(),
});

const AppointmentInput = z
  .object({
    id: z.uuid().optional(), // generado en el cliente (offline / idempotencia)
    branchId: z.uuid(),
    serviceId: z.uuid(),
    staffId: z.uuid().optional(),
    startsAt: z.iso.datetime({ offset: true }),
    clientId: z.uuid().optional(),
    newClient: ClientInput.pick({ fullName: true, phone: true }).optional(),
    notes: z.string().max(500).optional(),
    walkIn: z.boolean().default(false),
    allowOutsideHours: z.boolean().default(false),
  })
  .refine((a) => !(a.clientId && a.newClient), "Envía clientId o newClient, no ambos");

const StatusInput = z.object({
  status: z.enum(["checked_in", "completed", "cancelled", "no_show"]),
  reason: z.string().max(200).optional(),
});

const BlockInput = z
  .object({
    branchId: z.uuid(),
    staffId: z.uuid(),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    label: z.string().trim().max(60).default("Bloqueado"),
  })
  .refine((b) => Date.parse(b.startsAt) < Date.parse(b.endsAt), "El bloqueo debe terminar después de empezar");

/** Si el horario se ocupó, sugiere los 3 siguientes disponibles (en una transacción nueva). */
export async function withAlternatives<T>(
  pool: pg.Pool,
  tenantId: string,
  q: { branchId: string; serviceId: string; staffId?: string; startsAt: string; onlineOnly?: boolean; minLeadMin?: number },
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof SlotTakenError)) throw err;
    const alternatives = await withTenant(pool, { tenantId }, async (tx) => {
      const branch = await loadBranch(tx, q.branchId);
      const start = Date.parse(q.startsAt);
      const date = new Intl.DateTimeFormat("en-CA", { timeZone: branch.timezone }).format(start);
      const out: { start: string; staffIds: string[] }[] = [];
      for (let d = 0; d < 7 && out.length < 3; d++) {
        const day = addDays(date, d);
        const agenda = await loadDayAgenda(tx, { ...q, date: day });
        out.push(...availabilityFor(agenda, day, q.minLeadMin ?? 0).filter((s) => Date.parse(s.start) > start));
      }
      return out.slice(0, 3);
    });
    throw new DomainError(err.code, err.status, err.message, { alternatives });
  }
}

@Controller("v1")
export class AgendaController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get("branches/:branchId/availability")
  @InTenant()
  availability(@Ctx() ctx: TenantContext, @Param("branchId") branchId: string, @Query() query: unknown) {
    assertBranchAccess(ctx, branchId);
    const q = AvailabilityQuery.parse(query);
    return withTenant(this.pool, ctx, async (tx) => {
      const day = await loadDayAgenda(tx, { branchId, ...q });
      return { date: q.date, timezone: day.branch.timezone, slots: availabilityFor(day, q.date, 0) };
    });
  }

  /** Vista del día: columnas por estilista con citas y bloqueos. */
  @Get("branches/:branchId/agenda")
  @InTenant()
  day(@Ctx() ctx: TenantContext, @Param("branchId") branchId: string, @Query("date") dateRaw: string) {
    assertBranchAccess(ctx, branchId);
    const date = DATE.parse(dateRaw);
    return withTenant(this.pool, ctx, async (tx) => {
      const branch = await loadBranch(tx, branchId);
      const from = new Date(zonedToUtc(date, "00:00", branch.timezone)).toISOString();
      const to = new Date(zonedToUtc(addDays(date, 1), "00:00", branch.timezone)).toISOString();
      const staffFilter = ctx.role === "stylist" ? "AND st.user_id = $4" : "AND $4::uuid IS NULL";
      const { rows } = await tx.query(
        `SELECT b.id AS "bookingId", b.kind, b.label, b.staff_id AS "staffId", lower(b.period) AS "start", upper(b.period) AS "end",
                a.id AS "appointmentId", a.status, a.source, a.notes, b.price_cents AS "priceCents",
                s.name AS "serviceName", c.id AS "clientId", c.full_name AS "clientName", c.phone_e164 AS "clientPhone",
                c.no_show_count AS "clientNoShows"
         FROM agenda.staff_bookings b
         JOIN agenda.staff st ON st.id = b.staff_id
         LEFT JOIN agenda.appointments a ON a.id = b.appointment_id
         LEFT JOIN catalog.services s ON s.id = b.service_id
         LEFT JOIN crm.clients c ON c.id = a.client_id
         WHERE b.branch_id = $1 AND period && tstzrange($2, $3, '[)')
           AND (b.active OR a.status IN ('no_show', 'completed'))
           AND (b.kind <> 'hold' OR b.expires_at > now())
           ${staffFilter}
         ORDER BY lower(b.period)`,
        [branchId, from, to, ctx.role === "stylist" ? ctx.userId : null],
      );
      return { date, timezone: branch.timezone, items: rows };
    });
  }

  @Post("appointments")
  @InTenant("owner", "admin", "receptionist")
  async create(
    @Ctx() ctx: TenantContext,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const a = AppointmentInput.parse(body);
    assertBranchAccess(ctx, a.branchId);
    const res = await withAlternatives(this.pool, ctx.tenantId, a, () =>
      withTenant(this.pool, ctx, (tx) =>
        idempotent(tx, ctx.tenantId, key, a, async () => {
          let clientId = a.clientId ?? null;
          if (a.newClient?.phone) {
            clientId = await upsertClientByPhone(tx, ctx.tenantId, { fullName: a.newClient.fullName, phone: a.newClient.phone, source: "reception" });
          } else if (a.newClient) {
            clientId = uuidv7();
            await tx.query("INSERT INTO crm.clients (id, tenant_id, full_name, source) VALUES ($1, $2, $3, 'reception')", [
              clientId, ctx.tenantId, a.newClient.fullName,
            ]);
          }
          const appt = await book(tx, ctx.tenantId, {
            id: a.id,
            branchId: a.branchId,
            serviceId: a.serviceId,
            staffId: a.staffId,
            startsAt: a.startsAt,
            clientId,
            source: a.walkIn ? "walk_in" : "reception",
            notes: a.notes,
            createdBy: ctx.userId,
            allowOutsideHours: a.allowOutsideHours,
          });
          return { status: 201, body: appt };
        }),
      ),
    );
    reply.status(res.status);
    return res.body;
  }

  @Post("appointments/:id/status")
  @HttpCode(200)
  @InTenant("owner", "admin", "receptionist", "stylist")
  status(@Ctx() ctx: TenantContext, @Param("id") id: string, @Body() body: unknown) {
    const s = StatusInput.parse(body);
    if (ctx.role === "stylist" && s.status !== "checked_in" && s.status !== "completed") {
      throw new DomainError("FORBIDDEN", 403, "Solo recepción puede cancelar o marcar ausencias");
    }
    return withTenant(this.pool, ctx, (tx) => changeStatus(tx, ctx.tenantId, id, s.status, { by: "staff", reason: s.reason }));
  }

  @Post("blocks")
  @InTenant("owner", "admin", "receptionist")
  async block(@Ctx() ctx: TenantContext, @Body() body: unknown) {
    const b = BlockInput.parse(body);
    assertBranchAccess(ctx, b.branchId);
    return withTenant(this.pool, ctx, async (tx) => {
      const id = uuidv7();
      await tx.query("SAVEPOINT blk");
      try {
        await tx.query(
          `INSERT INTO agenda.staff_bookings (id, tenant_id, branch_id, staff_id, kind, period, label)
           VALUES ($1, $2, $3, $4, 'block', tstzrange($5, $6, '[)'), $7)`,
          [id, ctx.tenantId, b.branchId, b.staffId, b.startsAt, b.endsAt, b.label],
        );
      } catch (err) {
        await tx.query("ROLLBACK TO SAVEPOINT blk");
        if (pgErrorCode(err) === EXCLUSION_VIOLATION) throw conflict("SLOT_TAKEN", "Ya hay citas en ese horario. Muévelas antes de bloquearlo.");
        throw err;
      }
      await emit(tx, ctx.tenantId, "agenda.BlockCreated.v1", { blockId: id, staffId: b.staffId });
      return { id };
    });
  }

  @Delete("blocks/:id")
  @InTenant("owner", "admin", "receptionist")
  unblock(@Ctx() ctx: TenantContext, @Param("id") id: string) {
    return withTenant(this.pool, ctx, async (tx) => {
      const { rowCount } = await tx.query("UPDATE agenda.staff_bookings SET active = false WHERE id = $1 AND kind = 'block' AND active", [id]);
      if (!rowCount) throw notFound("El bloqueo");
      return { ok: true };
    });
  }
}

