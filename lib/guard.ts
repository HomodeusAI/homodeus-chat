import { authParticipantHeaderOrCookie, type Participant } from "./auth";
import { isMember } from "./store";

// Room-scoped gate: authenticate, then require the caller be a member of the room. Returns the
// participant, or a 401/403 Response the route returns as-is. Used by every room-scoped endpoint so
// a valid token cannot read, search, observe, or post into a room it was never added to.
export async function requireRoomMember(req: Request, roomId: string): Promise<Participant | Response> {
  const p = await authParticipantHeaderOrCookie(req);
  if (!p) return Response.json({ error: "unauthorized" }, { status: 401 });
  // An admin (god-view) may read/observe any channel without joining; everyone else must be a member.
  if (!p.admin && !(await isMember(roomId, p.id)))
    return Response.json({ error: "forbidden" }, { status: 403 });
  return p;
}
