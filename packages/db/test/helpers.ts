import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPool, migratorUrl, withTenant } from "../src/index.js";

export const admin = () => new pg.Pool({ connectionString: migratorUrl() });
export const runtime = () => createPool();

/** Crea un tenant con sucursal, estilista y servicio usando el rol migrador (fuera de RLS). */
export async function seedTenant(adminPool: pg.Pool, label: string) {
  const tenantId = randomUUID();
  const branchId = randomUUID();
  const staffId = randomUUID();
  const serviceId = randomUUID();
  const suffix = tenantId.slice(0, 8);
  await adminPool.query("INSERT INTO core.tenants (id, slug, name) VALUES ($1, $2, $3)", [tenantId, `${label}-${suffix}`, label]);
  await adminPool.query("INSERT INTO core.branches (id, tenant_id, name, booking_slug) VALUES ($1, $2, 'Principal', $3)", [branchId, tenantId, `${label}-${suffix}`]);
  await adminPool.query("INSERT INTO agenda.staff (id, tenant_id, branch_id, display_name) VALUES ($1, $2, $3, 'Lucho')", [staffId, tenantId, branchId]);
  await adminPool.query("INSERT INTO catalog.services (id, tenant_id, name, duration_min, price_cents) VALUES ($1, $2, 'Corte', 30, 2500)", [serviceId, tenantId]);
  return { tenantId, branchId, staffId, serviceId };
}

export { withTenant, randomUUID };
