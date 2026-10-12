const port = process.env.PGPORT ?? "54329";
const dbName = process.env.NODE_ENV === "test" ? "salon_test" : "salon_dev";

/** Conexión del rol dueño de las tablas: solo migraciones y tareas de plataforma. */
export const migratorUrl = (): string =>
  process.env.DATABASE_URL_MIGRATOR ?? `postgres://postgres:postgres@localhost:${port}/${dbName}`;

/** Conexión del runtime: rol app_runtime, sujeto a RLS. */
export const runtimeUrl = (): string =>
  process.env.DATABASE_URL ?? `postgres://app_runtime:${runtimePassword()}@localhost:${port}/${dbName}`;

export const runtimePassword = (): string => process.env.APP_RUNTIME_PASSWORD ?? "app_runtime_local";
