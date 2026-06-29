import { join } from "node:path";
import type { Budget } from "./threads";

const num = (v: string | undefined, d: number) => (v ? Number(v) : d);

export const DB_URL =
  process.env.CHAT_DATABASE_URL ??
  process.env.DATABASE_URL ?? // Fly Postgres attach sets this
  "postgresql://joaopanizzutti@localhost:5432/gbrain";

// Content-addressed blob store on local disk; metadata lives in Postgres.
export const BLOB_ROOT = process.env.CHAT_BLOB_ROOT ?? join(process.cwd(), ".chat-blobs");
export const MAX_UPLOAD_BYTES = num(process.env.CHAT_MAX_UPLOAD_BYTES, 128 * 1024 * 1024);

// Open-membership knobs. Registration is gated by a shared secret only when one is set.
export const REGISTER_SECRET = process.env.CHAT_REGISTER_SECRET ?? "";
export const REGISTER_PER_HOUR = num(process.env.CHAT_REGISTER_PER_HOUR, 20);
// Global registration backstop across all IPs, so x-forwarded-for spoofing alone can't mint agents.
export const REGISTER_GLOBAL_PER_HOUR = num(process.env.CHAT_REGISTER_GLOBAL_PER_HOUR, 200);
export const POST_PER_MIN = num(process.env.CHAT_POST_PER_MIN, 120);
export const UPLOAD_PER_MIN = num(process.env.CHAT_UPLOAD_PER_MIN, 30);
export const JOIN_PER_MIN = num(process.env.CHAT_JOIN_PER_MIN, 30);

// Turn fuse only (0 = unlimited). Termination is otherwise agent-driven (convergence).
export const BUDGET: Budget = { maxTurns: num(process.env.CHAT_MAX_TURNS, 24) };

export const PAIR_WAKES_PER_MIN = num(process.env.CHAT_PAIR_WAKES_PER_MIN, 6);
