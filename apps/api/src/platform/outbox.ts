import type { Tx } from "@salon/db";

/** Publica un evento de dominio en la misma transacción que el cambio (transactional outbox). */
export async function emit(tx: Tx, tenantId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
  await tx.query("INSERT INTO platform.outbox (tenant_id, event_type, payload) VALUES ($1, $2, $3)", [
    tenantId,
    eventType,
    JSON.stringify(payload),
  ]);
}

export async function audit(
  tx: Tx,
  entry: { tenantId: string; userId?: string; role?: string; action: string; entity: string; entityId?: string; changes?: unknown },
): Promise<void> {
  await tx.query(
    `INSERT INTO platform.audit_log (tenant_id, actor_user_id, actor_role, action, entity, entity_id, changes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.tenantId,
      entry.userId ?? null,
      entry.role ?? null,
      entry.action,
      entry.entity,
      entry.entityId ?? null,
      entry.changes === undefined ? null : JSON.stringify(entry.changes),
    ],
  );
}
