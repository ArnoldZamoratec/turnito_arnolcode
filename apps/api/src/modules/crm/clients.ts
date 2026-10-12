import { Body, Controller, Get, Inject, Module, Param, Post, Query } from "@nestjs/common";
import { pgErrorCode, type Tx, UNIQUE_VIOLATION, withTenant } from "@salon/db";
import { uuidv7 } from "@salon/kernel";
import type pg from "pg";
import { z } from "zod";
import { PG_POOL } from "../../platform/database.js";
import { conflict, notFound } from "../../platform/errors.js";
import { Ctx, InTenant, type TenantContext } from "../../platform/tenancy.js";

/** Normaliza teléfonos peruanos a E.164: "987 654 321" -> "+51987654321". */
export function normalizePhone(raw: string, defaultCountry = "51"): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return /^\+\d{8,15}$/.test(digits) ? digits : null;
  const d = digits.replace(/^00/, "");
  if (/^9\d{8}$/.test(d)) return `+${defaultCountry}${d}`; // móvil peruano
  if (d.startsWith(defaultCountry) && /^\d{10,15}$/.test(d)) return `+${d}`;
  return null;
}

export const Phone = z.string().transform((v, ctx) => {
  const p = normalizePhone(v);
  if (!p) ctx.addIssue({ code: "custom", message: "Teléfono inválido. Ejemplo: 987 654 321" });
  return p ?? "";
});

export const ClientInput = z.object({
  fullName: z.string().trim().min(2).max(100),
  phone: Phone.nullish(),
  email: z.email().nullish(),
  source: z.string().max(40).nullish(),
});

const CLIENT_COLUMNS = `id, full_name AS "fullName", phone_e164 AS "phone", email, no_show_count AS "noShowCount", created_at AS "createdAt"`;

/** Busca por teléfono o crea la clienta. Usado por recepción y por la reserva pública. */
export async function upsertClientByPhone(
  tx: Tx,
  tenantId: string,
  c: { fullName: string; phone: string; source: string },
): Promise<string> {
  const found = await tx.query<{ id: string }>(
    "SELECT id FROM crm.clients WHERE phone_e164 = $1 AND deleted_at IS NULL",
    [c.phone],
  );
  if (found.rows[0]) return found.rows[0].id;
  const id = uuidv7();
  await tx.query("INSERT INTO crm.clients (id, tenant_id, full_name, phone_e164, source) VALUES ($1, $2, $3, $4, $5)", [
    id,
    tenantId,
    c.fullName,
    c.phone,
    c.source,
  ]);
  return id;
}

export async function recordConsent(
  tx: Tx,
  tenantId: string,
  clientId: string,
  purpose: "service" | "reminders" | "marketing",
  granted: boolean,
  channel: "online_form" | "in_person",
  recordedBy: string | null,
): Promise<void> {
  await tx.query(
    `INSERT INTO crm.client_consents (id, tenant_id, client_id, purpose, granted, channel, policy_version, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-10', $7)`,
    [uuidv7(), tenantId, clientId, purpose, granted, channel, recordedBy],
  );
}

@Controller("v1/clients")
export class ClientsController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get()
  @InTenant()
  search(@Ctx() ctx: TenantContext, @Query("q") q?: string) {
    const term = (q ?? "").trim();
    return withTenant(this.pool, ctx, async (tx) => {
      if (!term) {
        return (await tx.query(`SELECT ${CLIENT_COLUMNS} FROM crm.clients WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 50`)).rows;
      }
      const phone = normalizePhone(term);
      const { rows } = await tx.query(
        `SELECT ${CLIENT_COLUMNS} FROM crm.clients
         WHERE deleted_at IS NULL AND (full_name ILIKE '%' || $1::text || '%' OR phone_e164 = $2::text OR phone_e164 LIKE '%' || $3::text)
         ORDER BY similarity(full_name, $1::text) DESC LIMIT 20`,
        [term, phone, term.replace(/\D/g, "") || "__none__"],
      );
      return rows;
    });
  }

  @Post()
  @InTenant()
  create(@Ctx() ctx: TenantContext, @Body() body: unknown) {
    const c = ClientInput.parse(body);
    return withTenant(this.pool, ctx, async (tx) => {
      try {
        const { rows } = await tx.query(
          `INSERT INTO crm.clients (id, tenant_id, full_name, phone_e164, email, source) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${CLIENT_COLUMNS}`,
          [uuidv7(), ctx.tenantId, c.fullName, c.phone ?? null, c.email ?? null, c.source ?? "reception"],
        );
        return rows[0];
      } catch (err) {
        if (pgErrorCode(err) === UNIQUE_VIOLATION) throw conflict("PHONE_TAKEN", "Ya existe una clienta con ese teléfono");
        throw err;
      }
    });
  }

  /** Ficha con historial de citas. */
  @Get(":id")
  @InTenant()
  get(@Ctx() ctx: TenantContext, @Param("id") id: string) {
    return withTenant(this.pool, ctx, async (tx) => {
      const client = (await tx.query(`SELECT ${CLIENT_COLUMNS} FROM crm.clients WHERE id = $1 AND deleted_at IS NULL`, [id])).rows[0];
      if (!client) throw notFound("La clienta");
      const history = (
        await tx.query(
          `SELECT a.id, a.status, a.starts_at AS "startsAt", s.name AS "serviceName", st.display_name AS "staffName"
           FROM agenda.appointments a
           LEFT JOIN agenda.staff_bookings b ON b.appointment_id = a.id AND b.kind = 'service'
           LEFT JOIN catalog.services s ON s.id = b.service_id
           LEFT JOIN agenda.staff st ON st.id = b.staff_id
           WHERE a.client_id = $1 AND a.status <> 'held'
           ORDER BY a.starts_at DESC LIMIT 50`,
          [id],
        )
      ).rows;
      return { ...client, history };
    });
  }
}

@Module({ controllers: [ClientsController] })
export class CrmModule {}
