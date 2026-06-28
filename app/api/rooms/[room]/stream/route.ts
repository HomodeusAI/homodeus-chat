import { subscribeRoom } from "@/lib/bus";
import { sseResponse } from "@/lib/sse";
import { requireRoomMember } from "@/lib/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Observer feed: every new message in the room, pushed live. Members only. The browser EventSource
// cannot set an Authorization header, so it authenticates via the httpOnly session cookie set by
// POST /api/session (requireRoomMember reads header or cookie) — no token in the URL.
export async function GET(req: Request, ctx: { params: Promise<{ room: string }> }) {
  const { room } = await ctx.params;
  const p = await requireRoomMember(req, room);
  if (p instanceof Response) return p;
  return sseResponse(req, (send) => {
    send({ type: "hello", room });
    return subscribeRoom(room, (ev) => send(ev));
  });
}
