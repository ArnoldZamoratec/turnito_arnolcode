import pg from "pg";

export type Tx = pg.PoolClient;

export interface TenantScope {
  tenantId: string;
}

/**
 * ÚNICA puerta de entrada a la BD para código de negocio.
 * Abre una transacción y fija app.tenant_id con SET LOCAL: las políticas RLS hacen el resto.
 */
export async function withTenant<T>(pool: pg.Pool, scope: TenantScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Transacción sin tenant: solo para funciones SECURITY DEFINER y tablas globales (auth). */
export async function withoutTenant<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Código SQLSTATE de una violación de constraint de exclusión (solapamiento de citas). */
export const EXCLUSION_VIOLATION = "23P01";
export const UNIQUE_VIOLATION = "23505";

export const pgErrorCode = (err: unknown): string | undefined =>
  typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
