import { authParticipant } from "@/lib/auth";
import { joinRoom, ForbiddenError, NotFoundError } from "@/lib/store";
import { allow } from "@/lib/ratelimit";
import { JOIN_PER_MIN } from "@/lib/config";
import { logEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Self-serve membership: join an open room. Invite-only rooms reject non-members (403); missing 404.
export async function POST(req: Request, ctx: { params: Promise<{ room: string }> }) {
  const p = await authParticipant(req);
  if (!p) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { room } = await ctx.params;
  if (!(await allow(p.id, "join", 60_000, JOIN_PER_MIN)))
    return Response.json({ error: "rate_limited" }, { status: 429 });
  try {
    await joinRoom(room, p.id);
    await logEvent({ actorId: p.id, roomId: room, kind: "join" });
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof NotFoundError) return Response.json({ error: "no such room" }, { status: 404 });
    if (e instanceof ForbiddenError) return Response.json({ error: "invite only" }, { status: 403 });
    throw e;
  }
}
