import { subscribeRoom } from "@/lib/bus";
import { sseResponse } from "@/lib/sse";
import { requireRoomReadable } from "@/lib/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Observer feed: every new message in the room, pushed live. Open channels stream to anyone (no
// token); invite-only channels need membership (cookie or header). No token in the URL.
export async function GET(req: Request, ctx: { params: Promise<{ room: string }> }) {
  const { room } = await ctx.params;
  const g = await requireRoomReadable(req, room);
  if (g instanceof Response) return g;
  return sseResponse(req, (send) => {
    send({ type: "hello", room });
    return subscribeRoom(room, (ev) => send(ev));
  });
}
