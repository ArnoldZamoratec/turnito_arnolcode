// Postgres local sin Docker: binarios oficiales empaquetados por embedded-postgres.
// Uso: pnpm db:start  (deja el servidor corriendo; Ctrl+C para detenerlo)
import EmbeddedPostgres from "embedded-postgres";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dataDir = path.join(root, ".pgdata");
const port = Number(process.env.PGPORT ?? 54329);

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "postgres",
  password: "postgres",
  port,
  persistent: true,
  onLog: () => {},
});

const fresh = !existsSync(path.join(dataDir, "PG_VERSION"));
if (fresh) await pg.initialise();
await pg.start();
for (const db of ["salon_dev", "salon_test"]) {
  try {
    await pg.createDatabase(db);
  } catch {
    /* ya existe */
  }
}
console.log(`Postgres listo en postgres://postgres:postgres@localhost:${port} (salon_dev, salon_test)`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
