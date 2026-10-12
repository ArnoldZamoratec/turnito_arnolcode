import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { admin, randomUUID, runtime, seedTenant, withTenant } from "./helpers.js";

let adminPool: pg.Pool;
let pool: pg.Pool;
let A: Awaited<ReturnType<typeof seedTenant>>;
let B: Awaited<ReturnType<typeof seedTenant>>;

beforeAll(async () => {
  adminPool = admin();
  pool = runtime();
  A = await seedTenant(adminPool, "salon-a");
  B = await seedTenant(adminPool, "salon-b");
});
afterAll(async () => {
  await pool.end();
  await adminPool.end();
});

describe("aislamiento entre tenants (RLS)", () => {
  it("toda tabla de negocio con tenant_id tiene RLS habilitada y forzada", async () => {
    const { rows } = await adminPool.query<{ tbl: string }>(`
      SELECT n.nspname || '.' || c.relname AS tbl
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE c.relkind = 'r'
        AND n.nspname IN ('core','catalog','crm','agenda','pos','commissions','notifications','platform')
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`);
    expect(rows.map((r) => r.tbl)).toEqual([]);
  });

  it("el rol de runtime no puede saltarse RLS", async () => {
    const { rows } = await adminPool.query("SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'app_runtime'");
    expect(rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });

  it("sin contexto de tenant no se ve ninguna fila", async () => {
    const { rows } = await pool.query("SELECT id FROM agenda.staff");
    expect(rows).toEqual([]);
  });

  it("cada tenant solo ve sus filas", async () => {
    const seenByA = await withTenant(pool, { tenantId: A.tenantId }, async (tx) =>
      (await tx.query<{ id: string }>("SELECT id FROM agenda.staff")).rows.map((r) => r.id));
    expect(seenByA).toEqual([A.staffId]);
  });

  it("no se puede insertar una fila con el tenant_id de otro salón", async () => {
    await expect(
      withTenant(pool, { tenantId: A.tenantId }, (tx) =>
        tx.query("INSERT INTO crm.clients (id, tenant_id, full_name) VALUES ($1, $2, 'Intrusa')", [randomUUID(), B.tenantId])),
    ).rejects.toThrow(/row-level security/);
  });

  it("no se puede referenciar una fila de otro tenant (FK compuesta)", async () => {
    await expect(
      withTenant(pool, { tenantId: A.tenantId }, (tx) =>
        tx.query(
          `INSERT INTO agenda.staff_bookings (id, tenant_id, branch_id, staff_id, kind, period)
           VALUES ($1, $2, $3, $4, 'block', tstzrange(now(), now() + interval '1 hour'))`,
          [randomUUID(), A.tenantId, A.branchId, B.staffId],
        )),
    ).rejects.toThrow(/foreign key/);
  });

  it("UPDATE y DELETE no alcanzan filas de otro tenant", async () => {
    const affected = await withTenant(pool, { tenantId: A.tenantId }, async (tx) => {
      const u = await tx.query("UPDATE agenda.staff SET display_name = 'hackeado' WHERE id = $1", [B.staffId]);
      const d = await tx.query("DELETE FROM catalog.services WHERE id = $1", [B.serviceId]);
      return (u.rowCount ?? 0) + (d.rowCount ?? 0);
    });
    expect(affected).toBe(0);
  });

  it("las funciones SECURITY DEFINER solo exponen lo mínimo", async () => {
    const { rows } = await pool.query("SELECT * FROM core.resolve_booking_slug($1)", [`SALON-A-${A.tenantId.slice(0, 8)}`]);
    expect(rows).toEqual([{ tenant_id: A.tenantId, branch_id: A.branchId }]);
  });
});
