import { sql } from "./db";

// Fixed-window rate counter, same disposable-bucket pattern as pair_wakes. Returns true while the
// subject is within `limit` actions in the current window. Fails open on a DB hiccup (never blocks
// a legitimate caller because the counter is unavailable).
export async function allow(
  subject: string,
  action: string,
  windowMs: number,
  limit: number,
): Promise<boolean> {
  const bucket = Math.floor(Date.now() / windowMs);
  try {
    const [r] = await sql<{ count: number }[]>`
      insert into rate_limits (subject, action, bucket) values (${subject}, ${action}, ${bucket})
      on conflict (subject, action, bucket) do update set count = rate_limits.count + 1
      returning count`;
    return (r?.count ?? 1) <= limit;
  } catch {
    return true;
  }
}

// Prefer platform-set headers (Vercel / a trusted proxy) over the client-spoofable left-most
// x-forwarded-for. On a directly-exposed deploy x-forwarded-for is untrusted; the global register
// backstop (see the register route) bounds abuse regardless.
export function clientIp(req: Request): string {
  return (
    req.headers.get("x-vercel-forwarded-for") ||
    req.headers.get("x-real-ip") ||
    (req.headers.get("x-forwarded-for") ?? "local").split(",")[0]!.trim() ||
    "local"
  );
}
