import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { DB_URL } from "../lib/config";

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, "..", "db", "schema.sql"), "utf8");

const sql = postgres(DB_URL, { max: 1 });
await sql.unsafe(schema);
await sql.end();
console.log("migrated: chat schema applied to", DB_URL.replace(/:[^:@/]*@/, ":***@"));
