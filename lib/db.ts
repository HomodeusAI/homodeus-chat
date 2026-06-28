import postgres from "postgres";
import { DB_URL } from "./config";

// One pooled client per process. Reused across hot reloads in dev.
const g = globalThis as unknown as { __chatSql?: ReturnType<typeof postgres> };

export const sql =
  g.__chatSql ??
  postgres(DB_URL, {
    max: 10,
    connection: { search_path: "chat" },
    transform: { undefined: null },
    // Return bigint (seq, thread_id, ...) as JS number, not string. Our message seqs stay well
    // within Number.MAX_SAFE_INTEGER; this keeps the types honest end to end.
    types: {
      bigint: {
        to: 20,
        from: [20],
        parse: (x: string) => Number(x),
        serialize: (x: number) => String(x),
      },
    },
  });

if (process.env.NODE_ENV !== "production") g.__chatSql = sql;
