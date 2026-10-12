import { Body, Controller, Get, Inject, Module, Param, Patch, Post } from "@nestjs/common";
import { withTenant } from "@salon/db";
import { uuidv7 } from "@salon/kernel";
import type pg from "pg";
import { z } from "zod";
import { PG_POOL } from "../../platform/database.js";
import { notFound } from "../../platform/errors.js";
import { audit } from "../../platform/outbox.js";
import { Ctx, InTenant, type TenantContext } from "../../platform/tenancy.js";

const ServiceInput = z.object({
  name: z.string().trim().min(2).max(80),
  category: z.string().trim().max(40).nullish(),
  durationMin: z.number().int().positive().max(600).multipleOf(5),
  bufferAfterMin: z.number().int().min(0).max(120).default(0),
  priceCents: z.number().int().min(0).max(10_000_000),
  bookableOnline: z.boolean().default(true),
});
const ServicePatch = ServiceInput.partial().extend({ active: z.boolean().optional() });

export const SERVICE_COLUMNS = `id, name, category, duration_min AS "durationMin", buffer_after_min AS "bufferAfterMin",
  price_cents AS "priceCents", bookable_online AS "bookableOnline", active, row_version AS "rowVersion"`;

@Controller("v1/services")
export class ServicesController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get()
  @InTenant()
  list(@Ctx() ctx: TenantContext) {
    return withTenant(this.pool, ctx, async (tx) =>
      (await tx.query(`SELECT ${SERVICE_COLUMNS} FROM catalog.services WHERE deleted_at IS NULL ORDER BY category NULLS LAST, name`)).rows,
    );
  }

  @Post()
  @InTenant("owner", "admin")
  create(@Ctx() ctx: TenantContext, @Body() body: unknown) {
    const s = ServiceInput.parse(body);
    return withTenant(this.pool, ctx, async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO catalog.services (id, tenant_id, name, category, duration_min, buffer_after_min, price_cents, bookable_online)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${SERVICE_COLUMNS}`,
        [uuidv7(), ctx.tenantId, s.name, s.category ?? null, s.durationMin, s.bufferAfterMin, s.priceCents, s.bookableOnline],
      );
      return rows[0];
    });
  }

  @Patch(":id")
  @InTenant("owner", "admin")
  update(@Ctx() ctx: TenantContext, @Param("id") id: string, @Body() body: unknown) {
    const p = ServicePatch.parse(body);
    return withTenant(this.pool, ctx, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE catalog.services SET
           name = COALESCE($2, name), category = CASE WHEN $3::boolean THEN $4 ELSE category END,
           duration_min = COALESCE($5, duration_min), buffer_after_min = COALESCE($6, buffer_after_min),
           price_cents = COALESCE($7, price_cents), bookable_online = COALESCE($8, bookable_online),
           active = COALESCE($9, active)
         WHERE id = $1 AND deleted_at IS NULL RETURNING ${SERVICE_COLUMNS}`,
        [id, p.name ?? null, p.category !== undefined, p.category ?? null, p.durationMin ?? null, p.bufferAfterMin ?? null,
          p.priceCents ?? null, p.bookableOnline ?? null, p.active ?? null],
      );
      if (!rows[0]) throw notFound("El servicio");
      if (p.priceCents !== undefined) {
        await audit(tx, { tenantId: ctx.tenantId, userId: ctx.userId, role: ctx.role, action: "service.price_changed", entity: "service", entityId: id, changes: { priceCents: p.priceCents } });
      }
      return rows[0];
    });
  }
}

@Module({ controllers: [ServicesController] })
export class CatalogModule {}
