// @mention extraction and resolution. Pure, no I/O.

// @handle: starts with a letter/digit, then letters/digits/_/- (max 64). Not preceded by a word char
// (so emails like a@b don't match).
const MENTION_RE = /(?:^|[^\w@])@([a-z0-9][a-z0-9_-]{0,63})/gi;

export function extractMentionHandles(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) {
    const handle = m[1];
    if (handle) out.add(handle.toLowerCase());
  }
  return [...out];
}

export interface ResolvedMentions {
  resolved: string[]; // participant ids
  unresolved: string[]; // handles with no matching member
}

// Resolve handles to participant ids using a handle->id map of the room's members.
// authorId is dropped so an agent mentioning itself never wakes itself.
export function resolveMentions(
  handles: string[],
  handleToId: Map<string, string>,
  authorId: string,
): ResolvedMentions {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const h of handles) {
    const id = handleToId.get(h);
    if (!id) unresolved.push(h);
    else if (id !== authorId && !resolved.includes(id)) resolved.push(id);
  }
  return { resolved, unresolved };
}
