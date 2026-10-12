import { Body, Controller, Get, Inject, Param, Post, Put, Query } from "@nestjs/common";
import { withTenant } from "@salon/db";
import { uuidv7 } from "@salon/kernel";
import type pg from "pg";
import { z } from "zod";
import { PG_POOL } from "../../platform/database.js";
import { invalid, notFound } from "../../platform/errors.js";
import { assertBranchAccess, Ctx, InTenant, type TenantContext } from "../../platform/tenancy.js";

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Usa formato HH:MM");
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Usa formato AAAA-MM-DD");

const StaffInput = z.object({
  branchId: z.uuid(),
  displayName: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  bookableOnline: z.boolean().default(true),
  serviceIds: z.array(z.uuid()).default([]),
});

const ScheduleInput = z.object({
  weekly: z
    .array(z.object({ weekday: z.number().int().min(1).max(7), start: HHMM, end: HHMM }))
    .max(28)
    .refine((list) => list.every((d) => d.start < d.end), "Cada tramo debe terminar después de empezar")
    .refine((list) => {
      for (const a of list)
        for (const b of list) if (a !== b && a.weekday === b.weekday && a.start < b.end && b.start < a.end) return false;
      return true;
    }, "Hay tramos que se solapan en el mismo día"),
});

const OverrideInput = z
  .object({ date: DATE, isOff: z.boolean(), start: HHMM.optional(), end: HHMM.optional(), reason: z.string().max(100).optional() })
  .refine((o) => o.isOff || (o.start && o.end && o.start < o.end), "Indica un horario válido o marca el día como libre");

@Controller("v1/staff")
export class StaffController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get()
  @InTenant()
  list(@Ctx() ctx: TenantContext, @Query("branchId") branchId?: string) {
    return withTenant(this.pool, ctx, async (tx) => {
      const { rows } = await tx.query(
        `SELECT st.id, st.branch_id AS "branchId", st.display_name AS "displayName", st.color, st.active,
                st.bookable_online AS "bookableOnline", st.user_id AS "userId",
                COALESCE((SELECT array_agg(service_id) FROM agenda.staff_services WHERE staff_id = st.id), '{}') AS "serviceIds",
                COALESCE((SELECT json_agg(json_build_object('weekday', weekday, 'start', to_char(start_local,'HH24:MI'), 'end', to_char(end_local,'HH24:MI')) ORDER BY weekday, start_local)
                          FROM agenda.working_hours WHERE staff_id = st.id AND valid_to IS NULL), '[]') AS "weekly"
         FROM agenda.staff st
         WHERE st.deleted_at IS NULL AND ($1::uuid IS NULL OR st.branch_id = $1::uuid)
         ORDER BY st.display_name`,
        [branchId ?? null],
      );
      return rows;
    });
  }

  @Post()
  @InTenant("owner", "admin")
  create(@Ctx() ctx: TenantContext, @Body() body: unknown) {
    const s = StaffInput.parse(body);
    assertBranchAccess(ctx, s.branchId);
    return withTenant(this.pool, ctx, async (tx) => {
      const id = uuidv7();
      await tx.query(
        "INSERT INTO agenda.staff (id, tenant_id, branch_id, display_name, color, bookable_online) VALUES ($1, $2, $3, $4, COALESCE($5, '#6366F1'), $6)",
        [id, ctx.tenantId, s.branchId, s.displayName, s.color ?? null, s.bookableOnline],
      );
      await replaceServices(tx, ctx.tenantId, id, s.serviceIds);
      return { id };
    });
  }

  /** Reemplaza la plantilla semanal desde hoy; la anterior queda cerrada (historial). */
  @Put(":id/schedule")
  @InTenant("owner", "admin")
  schedule(@Ctx() ctx: TenantContext, @Param("id") id: string, @Body() body: unknown) {
    const { weekly } = ScheduleInput.parse(body);
    return withTenant(this.pool, ctx, async (tx) => {
      await assertStaff(tx, id);
      await tx.query("DELETE FROM agenda.working_hours WHERE staff_id = $1 AND valid_from >= current_date", [id]);
      await tx.query("UPDATE agenda.working_hours SET valid_to = current_date - 1 WHERE staff_id = $1 AND valid_to IS NULL", [id]);
      for (const d of weekly) {
        await tx.query(
          "INSERT INTO agenda.working_hours (id, tenant_id, staff_id, weekday, start_local, end_local, valid_from) VALUES ($1, $2, $3, $4, $5, $6, current_date)",
          [uuidv7(), ctx.tenantId, id, d.weekday, d.start, d.end],
        );
      }
      return { ok: true };
    });
  }

  @Put(":id/services")
  @InTenant("owner", "admin")
  services(@Ctx() ctx: TenantContext, @Param("id") id: string, @Body() body: unknown) {
    const { serviceIds } = z.object({ serviceIds: z.array(z.uuid()) }).parse(body);
    return withTenant(this.pool, ctx, async (tx) => {
      await assertStaff(tx, id);
      await replaceServices(tx, ctx.tenantId, id, serviceIds);
      return { ok: true };
    });
  }

  /** Día libre, feriado u horario especial. */
  @Post(":id/overrides")
  @InTenant("owner", "admin", "receptionist")
  override(@Ctx() ctx: TenantContext, @Param("id") id: string, @Body() body: unknown) {
    const o = OverrideInput.parse(body);
    return withTenant(this.pool, ctx, async (tx) => {
      await assertStaff(tx, id);
      await tx.query("DELETE FROM agenda.staff_day_overrides WHERE staff_id = $1 AND on_date = $2", [id, o.date]);
      await tx.query(
        "INSERT INTO agenda.staff_day_overrides (id, tenant_id, staff_id, on_date, is_off, start_local, end_local, reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [uuidv7(), ctx.tenantId, id, o.date, o.isOff, o.isOff ? null : o.start, o.isOff ? null : o.end, o.reason ?? null],
      );
      // Citas que quedan afectadas: la recepción decide qué hacer con ellas (nunca se cancelan solas).
      const { rows } = await tx.query(
        `SELECT a.id, a.starts_at AS "startsAt" FROM agenda.staff_bookings b
         JOIN agenda.appointments a ON a.id = b.appointment_id
         JOIN core.branches br ON br.id = b.branch_id
         WHERE b.staff_id = $1 AND b.active AND b.kind = 'service'
           AND (lower(b.period) AT TIME ZONE br.timezone)::date = $2::date`,
        [id, o.date],
      );
      return { ok: true, affectedAppointments: rows };
    });
  }
}

async function assertStaff(tx: pg.PoolClient, id: string): Promise<void> {
  const { rowCount } = await tx.query("SELECT 1 FROM agenda.staff WHERE id = $1 AND deleted_at IS NULL", [id]);
  if (!rowCount) throw notFound("El estilista");
}

async function replaceServices(tx: pg.PoolClient, tenantId: string, staffId: string, serviceIds: string[]): Promise<void> {
  await tx.query("DELETE FROM agenda.staff_services WHERE staff_id = $1", [staffId]);
  if (!serviceIds.length) return;
  const { rowCount } = await tx.query(
    `INSERT INTO agenda.staff_services (tenant_id, staff_id, service_id)
     SELECT $1, $2, id FROM catalog.services WHERE id = ANY($3::uuid[]) AND deleted_at IS NULL`,
    [tenantId, staffId, serviceIds],
  );
  if (rowCount !== new Set(serviceIds).size) throw invalid("Algún servicio no existe");
}
