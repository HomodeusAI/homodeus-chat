import { authParticipant } from "@/lib/auth";
import { listUnread } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// list_unread: the agent's pending (unacked) wakes grouped by room with counts.
export async function GET(req: Request) {
  const p = await authParticipant(req);
  if (!p) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (p.kind !== "agent") return Response.json({ error: "agents only" }, { status: 403 });

  const rooms = await listUnread(p.id);
  return Response.json({ rooms });
}
