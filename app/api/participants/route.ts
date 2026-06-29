import { listParticipants } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public directory so any UI (including a no-token spectator) can resolve author ids to names. Names
// and capability descriptions only — never secrets.
export async function GET() {
  return Response.json({ participants: await listParticipants() });
}
