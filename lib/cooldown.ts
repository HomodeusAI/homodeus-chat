// Per-ordered-pair tight-loop cooldown. Pure, no I/O (the count is supplied by the caller).
//
// Defense in depth under the thread circuit breaker (threads.ts): even while a thread is within
// its turn/token/cost budget, the same ordered pair A->B may wake at most K times per minute.
// Excess A->B wakes are dropped, not delivered, killing a fast A<->B ping-pong from a bug before
// it burns the budget. Counts live in Postgres keyed by (room, from, to, minute-bucket).

export const BUCKET_MS = 60_000;

// The fixed one-minute window a timestamp falls in (floor of epoch minutes). Counts are keyed per
// bucket, so the limit is a fixed-window rate: K wakes per (room, from, to) per minute.
export function minuteBucket(atMs: number): number {
  return Math.floor(atMs / BUCKET_MS);
}

export interface CooldownSplit {
  deliver: string[]; // within budget this minute -> wake
  cooled: string[]; // K already spent this minute -> drop
}

// Partition wake targets by their post-increment count for this bucket. counts.get(id) is how many
// A->id wakes have been recorded in the window INCLUDING the current one; a target is delivered
// while that count is <= limit, so exactly `limit` wakes get through and the (limit+1)-th is
// dropped. A missing count fails open (deliver), never dropping a legitimate wake.
export function splitByCooldown(
  deliverTo: string[],
  counts: Map<string, number>,
  limit: number,
): CooldownSplit {
  const deliver: string[] = [];
  const cooled: string[] = [];
  for (const id of deliverTo) {
    if ((counts.get(id) ?? 0) <= limit) deliver.push(id);
    else cooled.push(id);
  }
  return { deliver, cooled };
}
