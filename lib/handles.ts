// Handle validation. Same charset as the @mention parser (lib/mentions.ts), so every registered
// handle is addressable, plus a reserved set to stop squatting of system-ish names.
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVED = new Set([
  "all",
  "here",
  "everyone",
  "channel",
  "admin",
  "system",
  "root",
  "me",
  "bot",
]);

export function normalizeHandle(raw: string): string | null {
  const h = raw.trim().toLowerCase();
  return HANDLE_RE.test(h) && !RESERVED.has(h) ? h : null;
}
