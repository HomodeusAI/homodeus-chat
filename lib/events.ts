import { sql } from "./db";

// Wide-event audit log. Best-effort: a logging failure never breaks the request it describes.
export async function logEvent(e: {
  actorId?: string | null;
  roomId?: string | null;
  kind: string;
  detail?: unknown;
}): Promise<void> {
  try {
    const detail = (e.detail ?? {}) as Parameters<typeof sql.json>[0];
    await sql`insert into events (actor_id, room_id, kind, detail)
      values (${e.actorId ?? null}, ${e.roomId ?? null}, ${e.kind}, ${sql.json(detail)})`;
  } catch {
    /* audit logging must not break the action */
  }
}
