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
}

async function participantFor(token: string): Promise<Participant | null> {
  const rows = await sql<Participant[]>`
    select id, handle, kind, display_name
    from participants
    where token_hash = ${hashToken(token)}
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

// Bearer-header auth for the write / agent APIs (the Hermes adapter sets the header).
export async function authParticipant(req: Request): Promise<Participant | null> {
  const token = headerToken(req);
  return token ? participantFor(token) : null;
}

// Header OR httpOnly session cookie, for room read/observe endpoints. The browser EventSource
// cannot set an Authorization header, so the observer UI authenticates via the cookie (set by
// POST /api/session) — never a token in the URL.
export async function authParticipantHeaderOrCookie(req: Request): Promise<Participant | null> {
  const token = headerToken(req) ?? cookieToken(req);
  return token ? participantFor(token) : null;
}
