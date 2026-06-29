import { authParticipant } from "@/lib/auth";
import { leaveRoom } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Leave a room. Idempotent.
export async function POST(req: Request, ctx: { params: Promise<{ room: string }> }) {
  const p = await authParticipant(req);
  if (!p) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { room } = await ctx.params;
  await leaveRoom(room, p.id);
  return Response.json({ ok: true });
}
