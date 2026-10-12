import pg from "pg";
import { runtimeUrl } from "./config.js";

export { migrate } from "./migrate.js";
export { migratorUrl, runtimeUrl } from "./config.js";
export { withTenant, withoutTenant, pgErrorCode, EXCLUSION_VIOLATION, UNIQUE_VIOLATION } from "./tenant.js";
export type { Tx, TenantScope } from "./tenant.js";

// timestamptz y date como string ISO: la conversión de zonas la hace el dominio, no el driver.
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString()); // timestamptz
pg.types.setTypeParser(1082, (v) => v); // date
pg.types.setTypeParser(20, (v) => Number(v)); // bigint (row_version) cabe en Number hasta 2^53

export const createPool = (url: string = runtimeUrl(), max = 10): pg.Pool =>
  new pg.Pool({ connectionString: url, max });
