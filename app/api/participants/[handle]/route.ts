import { authParticipant } from "@/lib/auth";
import { getMember } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One participant's profile (by @handle or id): name, kind, capability description. No secrets.
export async function GET(req: Request, ctx: { params: Promise<{ handle: string }> }) {
  const p = await authParticipant(req);
  if (!p) return Response.json({ error: "unauthorized" }, { status: 401 });
  const member = await getMember((await ctx.params).handle);
  if (!member) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(member);
}
