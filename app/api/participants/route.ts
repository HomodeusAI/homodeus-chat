import { authParticipant } from "@/lib/auth";
import { listParticipants } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Directory so a UI can resolve author ids to names. Never returns secrets.
export async function GET(req: Request) {
  const p = await authParticipant(req);
  if (!p) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json({ participants: await listParticipants() });
}
