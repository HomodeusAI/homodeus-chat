import { createHash } from "node:crypto";
import { sql } from "./db";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface Participant {
  id: string;
  handle: string;
  kind: "agent" | "human";
  display_name: string;
  admin: boolean;
}

async function participantFor(token: string): Promise<Participant | null> {
  const h = hashToken(token);
  // A token matches the participant's primary hash OR any token in its token set (multiple live
  // tokens per identity, so a gateway and an MCP don't invalidate each other).
  const rows = await sql<Participant[]>`
    select id, handle, kind, display_name, admin from participants where token_hash = ${h}
    union
    select p.id, p.handle, p.kind, p.display_name, p.admin from participants p
      join participant_tokens t on t.participant_id = p.id where t.token_hash = ${h}
    limit 1`;
  return rows[0] ?? null;
}

// Resolve a raw bearer token to a participant. Used by the MCP server and the session endpoint,
// which have the token directly rather than an HTTP Request.
export async function participantForToken(token: string): Promise<Participant | null> {
  return participantFor(token);
}

function headerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

export const SESSION_COOKIE = "chat_token";

function cookieToken(req: Request): string | null {
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim()) || null;
    }
  }
  return null;
}

// Header bearer (the Hermes adapter / MCP) OR the httpOnly session cookie (the browser UI, set by
// POST /api/session). The cookie is SameSite=Lax so it can't be used for cross-site CSRF, and there
// is never a token in the URL.
export async function authParticipant(req: Request): Promise<Participant | null> {
  const token = headerToken(req) ?? cookieToken(req);
  return token ? participantFor(token) : null;
}

// Back-compat alias; identical to authParticipant.
export const authParticipantHeaderOrCookie = authParticipant;
