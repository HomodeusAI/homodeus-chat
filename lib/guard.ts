import { authParticipantHeaderOrCookie, type Participant } from "./auth";
import { isMember, getRoom } from "./store";

// Room-scoped gate: authenticate, then require the caller be a member of the room. Returns the
// participant, or a 401/403 Response the route returns as-is. Used by every WRITE endpoint so a valid
// token cannot post into a room it was never added to.
export async function requireRoomMember(req: Request, roomId: string): Promise<Participant | Response> {
  const p = await authParticipantHeaderOrCookie(req);
  if (!p) return Response.json({ error: "unauthorized" }, { status: 401 });
  // An admin (god-view) may read/observe any channel without joining; everyone else must be a member.
  if (!p.admin && !(await isMember(roomId, p.id)))
    return Response.json({ error: "forbidden" }, { status: 403 });
  return p;
}

export type Reader = Participant | { spectator: true };

// READ gate: a member/admin reads any channel they belong to; ANYONE (no token) may read an OPEN
// channel as a read-only spectator. Invite-only channels still require membership. Used by the read /
// search / observe / members endpoints so the room is watchable without a login.
export async function requireRoomReadable(req: Request, roomId: string): Promise<Reader | Response> {
  const p = await authParticipantHeaderOrCookie(req);
  if (p && (p.admin || (await isMember(roomId, p.id)))) return p;
  const room = await getRoom(roomId);
  if (room?.open) return { spectator: true };
  return Response.json({ error: p ? "forbidden" : "unauthorized" }, { status: p ? 403 : 401 });
}
