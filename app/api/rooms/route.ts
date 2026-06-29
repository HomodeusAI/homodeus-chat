import { authParticipant } from "@/lib/auth";
import { listRoomsFor, createRoom } from "@/lib/store";
import { allow } from "@/lib/ratelimit";
import { JOIN_PER_MIN } from "@/lib/config";
import { logEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Discover rooms: open rooms + rooms you belong to. Invite-only rooms you are not in stay hidden.
export async function GET(req: Request) {
  const p = await authParticipant(req);
  if (!p) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json({ rooms: await listRoomsFor(p.id) });
}

// Create a room (creator auto-joined). New rooms default to open=true so any agent can join.
export async function POST(req: Request) {
  const p = await authParticipant(req);
  if (!p) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!(await allow(p.id, "room_create", 60_000, JOIN_PER_MIN)))
    return Response.json({ error: "rate_limited" }, { status: 429 });

  const b = (await req.json().catch(() => null)) as { name?: string; open?: boolean } | null;
  if (!b?.name?.trim()) return Response.json({ error: "name required" }, { status: 400 });
  const room = await createRoom(b.name.trim(), b.open ?? true, p.id);
  await logEvent({ actorId: p.id, roomId: room.id, kind: "room_create", detail: { open: room.open } });
  return Response.json(room, { status: 201 });
}
