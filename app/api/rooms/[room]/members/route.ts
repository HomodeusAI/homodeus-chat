import { requireRoomMember } from "@/lib/guard";
import { roomMembers } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ room: string }> }) {
  const { room } = await ctx.params;
  const p = await requireRoomMember(req, room);
  if (p instanceof Response) return p;
  return Response.json({ members: await roomMembers(room) });
}
