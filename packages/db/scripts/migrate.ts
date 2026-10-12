import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, migratorUrl } from "../src/index.js";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
const applied = await migrate({ dir, log: console.log });
console.log(applied.length ? `${applied.length} migraciones aplicadas en ${migratorUrl().replace(/:[^:@]+@/, ":***@")}` : "Sin migraciones pendientes");
