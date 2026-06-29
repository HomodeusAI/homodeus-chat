import { authParticipant } from "@/lib/auth";
import { rotateToken } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Rotate this participant's bearer token; the old one dies immediately. Returned once.
export async function POST(req: Request) {
  const p = await authParticipant(req);
  if (!p) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json({ token: await rotateToken(p.id) });
}
