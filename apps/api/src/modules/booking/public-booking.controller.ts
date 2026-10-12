// Reserva pública: la clienta final no inicia sesión. El tenant se resuelve por el slug del enlace
// y el contexto queda restringido a consultar disponibilidad y crear/confirmar holds de esa sucursal.
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { withoutTenant, withTenant } from "@salon/db";
import type pg from "pg";
import { z } from "zod";
import { config } from "../../config.js";
import { PG_POOL } from "../../platform/database.js";
import { notFound } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { Phone, recordConsent, upsertClientByPhone } from "../crm/clients.js";
import { withAlternatives } from "../agenda/agenda.controller.js";
import { availabilityFor, book, changeStatus, confirmHold, loadDayAgenda } from "../agenda/booking.service.js";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const HoldInput = z.object({
  serviceId: z.uuid(),
  staffId: z.uuid().optional(),
  startsAt: z.iso.datetime({ offset: true }),
});

const ConfirmInput = z.object({
  fullName: z.string().trim().min(2).max(100),
  phone: Phone,
  acceptReminders: z.boolean(),
  acceptPrivacy: z.literal(true, { error: "Debes aceptar la política de privacidad para reservar" }),
});

interface Resolved {
  tenantId: string;
  branchId: string;
}

@Controller("v1/public")
export class PublicBookingController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  private async resolve(slug: string): Promise<Resolved> {
    const r = await withoutTenant(this.pool, async (tx) =>
      (await tx.query<{ tenant_id: string; branch_id: string }>("SELECT * FROM core.resolve_booking_slug($1)", [slug])).rows[0],
    );
    if (!r) throw notFound("El salón");
    return { tenantId: r.tenant_id, branchId: r.branch_id };
  }

  /** Datos públicos del salón: sin información personal. Cacheable en la CDN. */
  @Get(":slug")
  async salon(@Param("slug") slug: string) {
    const { tenantId, branchId } = await this.resolve(slug);
    return withTenant(this.pool, { tenantId }, async (tx) => {
      const salon = (
        await tx.query(
          `SELECT t.name, b.address, b.phone_e164 AS phone, b.timezone, b.currency
           FROM core.tenants t JOIN core.branches b ON b.id = $1`,
          [branchId],
        )
      ).rows[0];
      const services = (
        await tx.query(
          `SELECT s.id, s.name, s.category, s.duration_min AS "durationMin", s.price_cents AS "priceCents"
           FROM catalog.services s
           WHERE s.active AND s.bookable_online AND s.deleted_at IS NULL
             AND EXISTS (SELECT 1 FROM agenda.staff_services ss JOIN agenda.staff st ON st.id = ss.staff_id
                         WHERE ss.service_id = s.id AND st.branch_id = $1 AND st.active AND st.bookable_online)
           ORDER BY s.category NULLS LAST, s.name`,
          [branchId],
        )
      ).rows;
      const staff = (
        await tx.query(
          `SELECT st.id, st.display_name AS "displayName", st.color,
                  COALESCE(array_agg(ss.service_id) FILTER (WHERE ss.service_id IS NOT NULL), '{}') AS "serviceIds"
           FROM agenda.staff st LEFT JOIN agenda.staff_services ss ON ss.staff_id = st.id
           WHERE st.branch_id = $1 AND st.active AND st.bookable_online AND st.deleted_at IS NULL
           GROUP BY st.id ORDER BY st.display_name`,
          [branchId],
        )
      ).rows;
      return { ...salon, slug, services, staff };
    });
  }

  @Get(":slug/availability")
  async availability(@Param("slug") slug: string, @Query() query: unknown) {
    const q = z.object({ serviceId: z.uuid(), date: DATE, staffId: z.uuid().optional() }).parse(query);
    const { tenantId, branchId } = await this.resolve(slug);
    return withTenant(this.pool, { tenantId }, async (tx) => {
      const day = await loadDayAgenda(tx, { branchId, ...q, onlineOnly: true });
      // La clienta no ve qué estilistas están libres si eligió "cualquiera": solo los horarios.
      const slots = availabilityFor(day, q.date, config.publicMinLeadMin).map((s) => ({ start: s.start }));
      return { date: q.date, timezone: day.branch.timezone, slots };
    });
  }

  /** Reserva temporal de 5 minutos mientras la clienta escribe sus datos. */
  @Post(":slug/holds")
  async hold(@Param("slug") slug: string, @Body() body: unknown, @Headers("idempotency-key") key?: string) {
    const h = HoldInput.parse(body);
    const { tenantId, branchId } = await this.resolve(slug);
    const horizon = Date.now() + config.horizonDays * 86_400_000;
    if (Date.parse(h.startsAt) > horizon) throw notFound("Ese horario");
    const res = await withAlternatives(
      this.pool,
      tenantId,
      { branchId, ...h, onlineOnly: true, minLeadMin: config.publicMinLeadMin },
      () =>
        withTenant(this.pool, { tenantId }, (tx) =>
          idempotent(tx, tenantId, key ? `public:${key}` : undefined, h, async () => {
            if (Date.parse(h.startsAt) < Date.now() + config.publicMinLeadMin * 60_000) {
              throw notFound("Ese horario");
            }
            const appt = await book(tx, tenantId, {
              branchId,
              serviceId: h.serviceId,
              staffId: h.staffId,
              startsAt: h.startsAt,
              clientId: null,
              source: "public",
              createdBy: null,
              allowOutsideHours: false,
              hold: true,
            });
            return { status: 201, body: { holdId: appt.id, startsAt: appt.startsAt, endsAt: appt.endsAt, expiresAt: appt.holdExpiresAt, priceCents: appt.priceCents } };
          }),
        ),
    );
    return res.body;
  }

  @Post(":slug/holds/:holdId/confirm")
  @HttpCode(200)
  async confirm(@Param("slug") slug: string, @Param("holdId") holdId: string, @Body() body: unknown) {
    const c = ConfirmInput.parse(body);
    const { tenantId } = await this.resolve(slug);
    return withTenant(this.pool, { tenantId }, async (tx) => {
      const exists = await tx.query("SELECT 1 FROM agenda.appointments WHERE id = $1 AND source = 'public'", [holdId]);
      if (!exists.rowCount) throw notFound("La reserva");
      const clientId = await upsertClientByPhone(tx, tenantId, { fullName: c.fullName, phone: c.phone, source: "public" });
      await confirmHold(tx, tenantId, holdId, clientId);
      await recordConsent(tx, tenantId, clientId, "service", true, "online_form", null);
      await recordConsent(tx, tenantId, clientId, "reminders", c.acceptReminders, "online_form", null);
      const appt = (
        await tx.query(
          `SELECT a.id, a.status, a.starts_at AS "startsAt", a.ends_at AS "endsAt", s.name AS "serviceName", st.display_name AS "staffName"
           FROM agenda.appointments a
           JOIN agenda.staff_bookings b ON b.appointment_id = a.id
           JOIN catalog.services s ON s.id = b.service_id
           JOIN agenda.staff st ON st.id = b.staff_id
           WHERE a.id = $1`,
          [holdId],
        )
      ).rows[0];
      return appt;
    });
  }

  /** Libera el hold si la clienta se arrepiente antes de confirmar. */
  @Post(":slug/holds/:holdId/release")
  @HttpCode(200)
  async release(@Param("slug") slug: string, @Param("holdId") holdId: string) {
    const { tenantId } = await this.resolve(slug);
    return withTenant(this.pool, { tenantId }, async (tx) => {
      const { rows } = await tx.query<{ status: string }>("SELECT status FROM agenda.appointments WHERE id = $1 AND source = 'public'", [holdId]);
      if (rows[0]?.status !== "held") return { ok: true };
      await changeStatus(tx, tenantId, holdId, "cancelled", { by: "client", reason: "hold liberado" });
      return { ok: true };
    });
  }
}
