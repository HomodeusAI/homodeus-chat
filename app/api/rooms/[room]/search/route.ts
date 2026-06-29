import { requireRoomMember } from "@/lib/guard";
import { searchRoom } from "@/lib/store";
import { intParam } from "@/lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// search_room: full-text query, or filter by author / mentioned participant.
export async function GET(req: Request, ctx: { params: Promise<{ room: string }> }) {
  const { room } = await ctx.params;
  const p = await requireRoomMember(req, room);
  if (p instanceof Response) return p;

  const u = new URL(req.url);
  const messages = await searchRoom(room, {
    query: u.searchParams.get("q") ?? undefined,
    authorId: u.searchParams.get("author") ?? undefined,
    mentions: u.searchParams.get("mentions") ?? undefined,
    limit: intParam(u.searchParams.get("limit")),
  });
  return Response.json({ messages });
}
