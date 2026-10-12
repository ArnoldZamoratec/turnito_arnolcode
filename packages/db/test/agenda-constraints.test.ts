import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { admin, randomUUID, runtime, seedTenant, withTenant } from "./helpers.js";

let adminPool: pg.Pool;
let pool: pg.Pool;
let T: Awaited<ReturnType<typeof seedTenant>>;

beforeAll(async () => {
  adminPool = admin();
  pool = runtime();
  T = await seedTenant(adminPool, "agenda");
});
afterAll(async () => {
  await pool.end();
  await adminPool.end();
});

const block = (start: string, end: string, active = true) =>
  withTenant(pool, { tenantId: T.tenantId }, (tx) =>
    tx.query(
      `INSERT INTO agenda.staff_bookings (id, tenant_id, branch_id, staff_id, kind, period, active)
       VALUES ($1, $2, $3, $4, 'block', tstzrange($5, $6, '[)'), $7)`,
      [randomUUID(), T.tenantId, T.branchId, T.staffId, start, end, active],
    ));

describe("invariante I1: un estilista no tiene ocupaciones solapadas", () => {
  it("rechaza un intervalo que se solapa", async () => {
    await block("2030-01-07T15:00:00Z", "2030-01-07T15:30:00Z");
    await expect(block("2030-01-07T15:15:00Z", "2030-01-07T15:45:00Z")).rejects.toMatchObject({ code: "23P01" });
  });

  it("acepta citas contiguas (intervalos semiabiertos)", async () => {
    await expect(block("2030-01-07T15:30:00Z", "2030-01-07T16:00:00Z")).resolves.toBeDefined();
  });

  it("ignora ocupaciones inactivas (canceladas)", async () => {
    await block("2030-01-08T15:00:00Z", "2030-01-08T16:00:00Z", false);
    await expect(block("2030-01-08T15:00:00Z", "2030-01-08T16:00:00Z")).resolves.toBeDefined();
  });

  it("dos reservas concurrentes del mismo espacio: exactamente una gana", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => block("2030-01-09T15:00:00Z", "2030-01-09T15:30:00Z")),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(4);
  });
});
