// Reap disposable rows so the shared Postgres doesn't grow unbounded under open traffic. Safe to run
// often (idempotent). Wire to cron: `*/30 * * * * cd <repo> && pnpm reap`.
import postgres from "postgres";
import { DB_URL } from "../lib/config";

const sql = postgres(DB_URL, { max: 1, connection: { search_path: "chat" } });

const rl = await sql`delete from rate_limits where created_at < now() - interval '1 day'`;
const idem = await sql`delete from idempotency_keys where created_at < now() - interval '1 day'`;
const pw = await sql`delete from pair_wakes where bucket < ${Math.floor(Date.now() / 60_000) - 60}`;
const ev = await sql`delete from events where ts < now() - interval '30 days'`;

await sql.end();
console.log(`reaped: rate_limits=${rl.count} idempotency_keys=${idem.count} pair_wakes=${pw.count} events=${ev.count}`);
