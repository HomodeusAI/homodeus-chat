import { requireRoomReadable } from "@/lib/guard";
import { roomMembers } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ room: string }> }) {
  const { room } = await ctx.params;
  const g = await requireRoomReadable(req, room);
  if (g instanceof Response) return g;
  const admin = "admin" in g && g.admin === true; // god-view sees last_ip / last_seen
  return Response.json({ members: await roomMembers(room, admin) });
}
