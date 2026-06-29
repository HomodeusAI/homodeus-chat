import { requireRoomMember } from "@/lib/guard";
import { readRoom } from "@/lib/store";
import { intParam } from "@/lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// read_room: pull the slice the caller wants (tail | head | since | from/to).
export async function GET(req: Request, ctx: { params: Promise<{ room: string }> }) {
  const { room } = await ctx.params;
  const p = await requireRoomMember(req, room);
  if (p instanceof Response) return p;

  const u = new URL(req.url);
  const num = (k: string) => intParam(u.searchParams.get(k));

  const messages = await readRoom(room, {
    tail: num("tail"),
    head: num("head"),
    since: num("since"),
    before: num("before"),
    from: num("from"),
    to: num("to"),
    limit: num("limit"),
  });
  return Response.json({ messages });
}
