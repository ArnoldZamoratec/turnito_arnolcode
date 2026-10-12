import { Body, Controller, Get, Inject, Module, Post } from "@nestjs/common";
import { withTenant, withoutTenant } from "@salon/db";
import { isValidTimeZone, uuidv7 } from "@salon/kernel";
import type pg from "pg";
import { z } from "zod";
import { PG_POOL } from "../../platform/database.js";
import { conflict } from "../../platform/errors.js";
import { audit } from "../../platform/outbox.js";
import { Authenticated, Ctx, CurrentUser, InTenant, type SessionUser, type TenantContext } from "../../platform/tenancy.js";

// Plantillas para que el salón quede listo en minutos (precios en céntimos de sol, editables).
const TEMPLATES = {
  barberia: [
    { name: "Corte de cabello", category: "Corte", durationMin: 30, priceCents: 2500 },
    { name: "Corte + barba", category: "Corte", durationMin: 45, priceCents: 3500 },
    { name: "Perfilado de barba", category: "Barba", durationMin: 20, priceCents: 1500 },
    { name: "Corte niño", category: "Corte", durationMin: 30, priceCents: 2000 },
  ],
  peluqueria: [
    { name: "Corte dama", category: "Corte", durationMin: 45, priceCents: 3500 },
    { name: "Corte caballero", category: "Corte", durationMin: 30, priceCents: 2500 },
    { name: "Tinte completo", category: "Color", durationMin: 120, priceCents: 12000 },
    { name: "Mechas / balayage", category: "Color", durationMin: 180, priceCents: 22000 },
    { name: "Brushing / planchado", category: "Peinado", durationMin: 45, priceCents: 3000 },
  ],
  unas: [
    { name: "Manicure tradicional", category: "Manos", durationMin: 45, priceCents: 2500 },
    { name: "Manicure gel", category: "Manos", durationMin: 60, priceCents: 4500 },
    { name: "Pedicure", category: "Pies", durationMin: 60, priceCents: 3500 },
  ],
} as const;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;

export const OnboardingInput = z.object({
  salonName: z.string().trim().min(2).max(80),
  slug: z.string().trim().toLowerCase().regex(SLUG_RE, "Usa solo minúsculas, números y guiones (3 a 48 caracteres)"),
  timezone: z.string().default("America/Lima").refine(isValidTimeZone, "Zona horaria inválida"),
  template: z.enum(["barberia", "peluqueria", "unas", "vacio"]).default("barberia"),
  ownerIsStylist: z.boolean().default(true),
  ownerDisplayName: z.string().trim().min(1).max(40).optional(),
});

const DEFAULT_WEEK = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "09:00", end: "19:00" }));

@Controller("v1")
export class OnboardingController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** Perfil y salones del usuario: alimenta el selector de salón del panel. */
  @Get("me")
  @Authenticated()
  async me(@CurrentUser() user: SessionUser) {
    const { rows } = await this.pool.query(
      "SELECT tenant_id AS \"tenantId\", tenant_name AS \"name\", tenant_slug AS \"slug\", role, branch_ids AS \"branchIds\" FROM core.memberships_for_user($1)",
      [user.id],
    );
    return { user, salons: rows };
  }

  /** Sucursales del salón activo visibles para el usuario. */
  @Get("branches")
  @InTenant()
  branches(@Ctx() ctx: TenantContext) {
    return withTenant(this.pool, ctx, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id, name, timezone, booking_slug AS "bookingSlug", slot_step_min AS "slotStepMin", currency
         FROM core.branches WHERE deleted_at IS NULL ORDER BY created_at`,
      );
      return ctx.branchIds ? rows.filter((b) => ctx.branchIds!.includes(b.id)) : rows;
    });
  }

  /** Crea el salón, su primera sucursal y al usuario como dueño. */
  @Post("onboarding")
  @Authenticated()
  async create(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const input = OnboardingInput.parse(body);
    const taken = await withoutTenant(this.pool, async (tx) =>
      (await tx.query<{ t: boolean }>("SELECT core.is_slug_taken($1) AS t", [input.slug])).rows[0]!.t,
    );
    if (taken) throw conflict("SLUG_TAKEN", "Ese enlace ya está en uso. Prueba con otro.");

    const tenantId = uuidv7();
    const branchId = uuidv7();
    await withTenant(this.pool, { tenantId }, async (tx) => {
      await tx.query("INSERT INTO core.tenants (id, slug, name) VALUES ($1, $2, $3)", [tenantId, input.slug, input.salonName]);
      await tx.query(
        "INSERT INTO core.branches (id, tenant_id, name, booking_slug, timezone) VALUES ($1, $2, 'Principal', $3, $4)",
        [branchId, tenantId, input.slug, input.timezone],
      );
      await tx.query("INSERT INTO core.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')", [tenantId, user.id]);

      const serviceIds: string[] = [];
      const template = input.template === "vacio" ? [] : TEMPLATES[input.template];
      for (const s of template) {
        const id = uuidv7();
        serviceIds.push(id);
        await tx.query(
          "INSERT INTO catalog.services (id, tenant_id, name, category, duration_min, price_cents) VALUES ($1, $2, $3, $4, $5, $6)",
          [id, tenantId, s.name, s.category, s.durationMin, s.priceCents],
        );
      }

      if (input.ownerIsStylist) {
        const staffId = uuidv7();
        await tx.query(
          "INSERT INTO agenda.staff (id, tenant_id, branch_id, user_id, display_name) VALUES ($1, $2, $3, $4, $5)",
          [staffId, tenantId, branchId, user.id, input.ownerDisplayName ?? user.name.split(" ")[0]],
        );
        for (const sid of serviceIds) {
          await tx.query("INSERT INTO agenda.staff_services (tenant_id, staff_id, service_id) VALUES ($1, $2, $3)", [
            tenantId,
            staffId,
            sid,
          ]);
        }
        for (const d of DEFAULT_WEEK) {
          await tx.query(
            "INSERT INTO agenda.working_hours (id, tenant_id, staff_id, weekday, start_local, end_local, valid_from) VALUES ($1, $2, $3, $4, $5, $6, '2000-01-01')",
            [uuidv7(), tenantId, staffId, d.weekday, d.start, d.end],
          );
        }
      }
      await audit(tx, { tenantId, userId: user.id, role: "owner", action: "tenant.created", entity: "tenant", entityId: tenantId });
    });
    return { tenantId, branchId, slug: input.slug };
  }
}

@Module({ controllers: [OnboardingController] })
export class IamModule {}
