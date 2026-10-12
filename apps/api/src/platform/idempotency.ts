import { createHash } from "node:crypto";
import type { Tx } from "@salon/db";
import { conflict, invalid } from "./errors.js";

export interface StoredResponse<T> {
  status: number;
  body: T;
}

/**
 * Ejecuta `fn` una sola vez por (tenant, clave). Debe llamarse dentro de la misma transacción
 * que la operación: si la operación falla, la clave también se revierte y el cliente puede reintentar.
 * Un reintento con la misma clave devuelve la respuesta guardada; con otro cuerpo, 422.
 */
export async function idempotent<T>(
  tx: Tx,
  tenantId: string,
  key: string | undefined,
  request: unknown,
  fn: () => Promise<StoredResponse<T>>,
): Promise<StoredResponse<T>> {
  if (!key) return fn();
  if (key.length > 200) throw invalid("Idempotency-Key demasiado larga");
  const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");

  const inserted = await tx.query(
    `INSERT INTO platform.idempotency_keys (tenant_id, key, request_hash) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, key) DO NOTHING`,
    [tenantId, key, hash],
  );
  if (inserted.rowCount === 0) {
    const { rows } = await tx.query<{ request_hash: string; response_status: number | null; response_body: T }>(
      "SELECT request_hash, response_status, response_body FROM platform.idempotency_keys WHERE tenant_id = $1 AND key = $2",
      [tenantId, key],
    );
    const prev = rows[0]!;
    if (prev.request_hash !== hash) throw invalid("La Idempotency-Key ya se usó con otros datos");
    if (prev.response_status === null) throw conflict("REQUEST_IN_PROGRESS", "La misma solicitud se está procesando");
    return { status: prev.response_status, body: prev.response_body };
  }

  const res = await fn();
  await tx.query(
    "UPDATE platform.idempotency_keys SET response_status = $3, response_body = $4 WHERE tenant_id = $1 AND key = $2",
    [tenantId, key, res.status, JSON.stringify(res.body)],
  );
  return res;
}
