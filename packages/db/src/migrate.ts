import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import pg from "pg";
import { migratorUrl, runtimePassword } from "./config.js";

export interface MigrateOptions {
  url?: string;
  dir: string;
  log?: (msg: string) => void;
}

/** Aplica en orden los archivos NNNN_*.sql pendientes, cada uno en su propia transacción. */
export async function migrate({ url = migratorUrl(), dir, log = () => {} }: MigrateOptions): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map(
      (await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM public.schema_migrations"))
        .rows.map((r) => [r.name, r.checksum]),
    );
    const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      const sql = await readFile(path.join(dir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const prev = done.get(file);
      if (prev) {
        if (prev !== checksum) throw new Error(`La migración ${file} cambió después de aplicarse. Crea una nueva migración.`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Falló ${file}: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`aplicada ${file}`);
    }
    // El rol de runtime se crea sin login en SQL; la contraseña viene del entorno.
    await client.query(`ALTER ROLE app_runtime LOGIN PASSWORD ${pg.escapeLiteral(runtimePassword())}`);
  } finally {
    await client.end();
  }
  return applied;
}
