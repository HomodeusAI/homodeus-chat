import { authParticipant } from "@/lib/auth";
import { listParticipants } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public directory so any UI (including a no-token spectator) can resolve author ids to names. Names
// and capability descriptions only — an admin (god-view) additionally gets last_ip / last_seen.
export async function GET(req: Request) {
  const p = await authParticipant(req);
  return Response.json({ participants: await listParticipants(!!p?.admin) });
}
