import { randomBytes } from "node:crypto";
import { sql } from "./db";
import { hashToken } from "./auth";
import { BUDGET, PAIR_WAKES_PER_MIN } from "./config";
import { extractMentionHandles, resolveMentions } from "./mentions";
import { decideDelivery, type Ledger, type ThreadStatus } from "./threads";
import { minuteBucket, splitByCooldown } from "./cooldown";

export interface Attachment {
  id: number;
  sha256: string;
  size: number;
  content_type: string;
  filename: string;
}

export interface Message {
  seq: number;
  room_id: string;
  author_id: string;
  author_handle?: string | null;
  author_name?: string | null;
  body: string;
  thread_id: number;
  parent_seq: number | null;
  depth: number;
  created_at: string;
  attachments?: Attachment[];
}

export interface PostInput {
  authorId: string;
  authorKind: "agent" | "human";
  roomId: string;
  body: string;
  parentSeq?: number | null;
  attachmentIds?: number[];
  idempotencyKey?: string;
}

export interface PostResult {
  message: Message;
  deliverTo: string[];
  haltReason?: string;
  status: ThreadStatus;
  mentionedAgentIds: string[];
  replayed?: boolean;
}

// Thrown when a caller acts on a room it is not a member of. Routes map it to 403.
export class ForbiddenError extends Error {
  constructor(message = "forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export async function isMember(roomId: string, participantId: string): Promise<boolean> {
  const rows = await sql`
    select 1 from members where room_id = ${roomId} and participant_id = ${participantId} limit 1`;
  return rows.length > 0;
}

// The single write path. One transaction: resolve mentions, thread the message, run the
// termination decision, persist the ledger, and write durable wake rows for delivered agents.
export async function postMessage(input: PostInput): Promise<PostResult> {
  return sql.begin(async (tx) => {
    const members = await tx<{ id: string; handle: string; kind: string }[]>`
      select p.id, p.handle, p.kind
      from members m
      join participants p on p.id = m.participant_id
      where m.room_id = ${input.roomId}`;
    const handleToId = new Map(members.map((m) => [m.handle, m.id]));
    const agentIds = new Set(members.filter((m) => m.kind === "agent").map((m) => m.id));

    // Authorize at the write boundary: only a member of the room may post into it. Throwing here
    // rolls back the transaction, so a non-member's message is never inserted and wakes no one.
    if (!members.some((m) => m.id === input.authorId)) {
      throw new ForbiddenError("author is not a member of the room");
    }

    // Idempotency: RESERVE the key before any side effect, so two concurrent same-(author,key) posts
    // serialize on the unique PK instead of each inserting a message + wake. The loser's insert
    // blocks until the winner commits, then replays the winner's message.
    if (input.idempotencyKey) {
      const reserved = await tx`
        insert into idempotency_keys (participant_id, room_id, key)
        values (${input.authorId}, ${input.roomId}, ${input.idempotencyKey})
        on conflict (participant_id, room_id, key) do nothing returning participant_id`;
      if (!reserved.length) {
        const [hit] = await tx<{ message_seq: number | null }[]>`
          select message_seq from idempotency_keys
          where participant_id = ${input.authorId} and room_id = ${input.roomId} and key = ${input.idempotencyKey}`;
        if (hit?.message_seq) {
          const [m] = await tx<Message[]>`select * from messages where seq = ${hit.message_seq}`;
          const [t] = await tx<{ status: ThreadStatus }[]>`select status from threads where id = ${m!.thread_id}`;
          return { message: m!, deliverTo: [], status: t?.status ?? "open", mentionedAgentIds: [], replayed: true };
        }
        throw new ForbiddenError("idempotency key in flight"); // vanishingly rare; the client retries
      }
    }

    const handles = extractMentionHandles(input.body);
    const { resolved } = resolveMentions(handles, handleToId, input.authorId);
    const mentionedAgentIds = resolved.filter((id) => agentIds.has(id));

    let threadId: number | null = null;
    let depth = 0;
    let parentSeq: number | null = null;
    if (input.parentSeq != null) {
      // Scope the parent to THIS room: otherwise a member of room A could pass a parent_seq from
      // room B and inherit B's thread, corrupting B's ledger. No match -> treat as a new seed, and
      // store no parent_seq (a dangling/cross-room parent must never be persisted on the row).
      const [parent] = await tx<{ thread_id: number; depth: number }[]>`
        select thread_id, depth from messages where seq = ${input.parentSeq} and room_id = ${input.roomId}`;
      if (parent) {
        threadId = parent.thread_id;
        depth = parent.depth + 1;
        parentSeq = input.parentSeq;
      }
    }

    const [msg] = await tx<Message[]>`
      insert into messages (room_id, author_id, body, thread_id, parent_seq, depth)
      values (${input.roomId}, ${input.authorId}, ${input.body}, ${threadId},
              ${parentSeq}, ${depth})
      returning *`;
    if (!msg) throw new Error("insert failed");

    if (threadId == null) {
      threadId = msg.seq; // a seed thread points at itself
      await tx`update messages set thread_id = ${threadId} where seq = ${msg.seq}`;
      msg.thread_id = threadId;
    }

    if (resolved.length) {
      await tx`insert into mentions ${tx(
        resolved.map((pid) => ({ message_seq: msg.seq, participant_id: pid })),
      )} on conflict do nothing`;
    }

    // Link attachments. An author may only attach files it uploaded — secure and simple.
    if (input.attachmentIds?.length) {
      const owned = await tx<{ id: number }[]>`
        select id from attachments
        where id in ${tx(input.attachmentIds)} and uploader_id = ${input.authorId}`;
      const ownedSet = new Set(owned.map((a) => a.id));
      if (input.attachmentIds.some((id) => !ownedSet.has(id))) {
        throw new ForbiddenError("attachment not owned by author");
      }
      await tx`insert into message_attachments ${tx(
        input.attachmentIds.map((id, idx) => ({ message_seq: msg.seq, attachment_id: id, idx })),
      )} on conflict do nothing`;
    }

    if (input.idempotencyKey) {
      await tx`update idempotency_keys set message_seq = ${msg.seq}
        where participant_id = ${input.authorId} and room_id = ${input.roomId} and key = ${input.idempotencyKey}`;
    }

    const [thread] = await tx<{ turn_count: number; status: ThreadStatus }[]>`
      insert into threads (id, room_id) values (${threadId}, ${input.roomId})
      on conflict (id) do update set updated_at = now()
      returning turn_count, status`;
    if (!thread) throw new Error("thread upsert failed");

    const prev: Ledger = { turnCount: thread.turn_count, status: thread.status };

    const decision = decideDelivery(
      prev,
      { authorKind: input.authorKind, mentionedAgentIds },
      BUDGET,
    );

    await tx`update threads set
        turn_count = ${decision.ledger.turnCount},
        status = ${decision.ledger.status},
        halt_reason = ${decision.haltReason ?? null},
        updated_at = now()
      where id = ${threadId}`;

    // Tight-loop cooldown (defense in depth under the breaker): an agent may wake the same peer at
    // most CHAT_PAIR_WAKES_PER_MIN times per minute; excess A->B wakes are dropped, not delivered.
    // Operator (human) posts bypass it, like they bypass the budget.
    let deliverTo = decision.deliverTo;
    if (input.authorKind === "agent" && deliverTo.length) {
      const bucket = minuteBucket(Date.now());
      const counts = await tx<{ to_id: string; wake_count: number }[]>`
        insert into pair_wakes ${tx(
          deliverTo.map((to) => ({
            room_id: input.roomId,
            from_id: input.authorId,
            to_id: to,
            bucket,
          })),
        )}
        on conflict (room_id, from_id, to_id, bucket)
        do update set wake_count = pair_wakes.wake_count + 1
        returning to_id, wake_count`;
      deliverTo = splitByCooldown(
        deliverTo,
        new Map(counts.map((r) => [r.to_id, r.wake_count])),
        PAIR_WAKES_PER_MIN,
      ).deliver;
    }

    if (deliverTo.length) {
      await tx`insert into wakes ${tx(
        deliverTo.map((pid) => ({ message_seq: msg.seq, participant_id: pid })),
      )} on conflict do nothing`;
    }

    if (input.attachmentIds?.length) {
      msg.attachments = await tx<Attachment[]>`
        select a.id, a.sha256, a.size, a.content_type, a.filename
        from message_attachments ma join attachments a on a.id = ma.attachment_id
        where ma.message_seq = ${msg.seq} order by ma.idx`;
    }

    return {
      message: msg,
      deliverTo,
      haltReason: decision.haltReason,
      status: decision.ledger.status,
      mentionedAgentIds,
    };
  });
}

// Attach each message's files (for read responses, the observer UI, and the agent wake stream so a
// Hermes agent can download inbound attachments). One query for a whole page of messages.
export async function enrichAttachments(messages: Message[]): Promise<Message[]> {
  if (!messages.length) return messages;
  const rows = await sql<(Attachment & { message_seq: number })[]>`
    select ma.message_seq, a.id, a.sha256, a.size, a.content_type, a.filename
    from message_attachments ma
    join attachments a on a.id = ma.attachment_id
    where ma.message_seq in ${sql(messages.map((m) => m.seq))}
    order by ma.message_seq, ma.idx`;
  const byMsg = new Map<number, Attachment[]>();
  for (const r of rows) {
    const list = byMsg.get(r.message_seq) ?? [];
    list.push({ id: r.id, sha256: r.sha256, size: r.size, content_type: r.content_type, filename: r.filename });
    byMsg.set(r.message_seq, list);
  }
  return messages.map((m) => ({ ...m, attachments: byMsg.get(m.seq) ?? [] }));
}

// Attach the author's handle + display name inline so a reader knows who spoke without a separate
// /api/participants join.
export async function enrichAuthors(messages: Message[]): Promise<Message[]> {
  if (!messages.length) return messages;
  const ids = [...new Set(messages.map((m) => m.author_id))];
  const ps = await sql<{ id: string; handle: string; display_name: string }[]>`
    select id, handle, display_name from participants where id in ${sql(ids)}`;
  const by = new Map(ps.map((p) => [p.id, p]));
  return messages.map((m) => ({
    ...m,
    author_handle: by.get(m.author_id)?.handle ?? null,
    author_name: by.get(m.author_id)?.display_name ?? null,
  }));
}

const enrich = async (rows: Message[]) => enrichAuthors(await enrichAttachments(rows));

export interface ReadOpts {
  tail?: number;
  head?: number;
  since?: number;
  before?: number;
  from?: number;
  to?: number;
  limit?: number;
}

export async function readRoom(roomId: string, o: ReadOpts): Promise<Message[]> {
  const cap = Math.min(o.limit ?? 200, 500);
  let rows: Message[];
  if (o.before != null) {
    rows = (
      await sql<Message[]>`select * from messages where room_id = ${roomId} and seq < ${o.before}
        order by seq desc limit ${Math.min(o.limit ?? 50, cap)}`
    ).reverse();
  } else if (o.head != null) {
    rows = await sql<Message[]>`select * from messages where room_id = ${roomId}
      order by seq asc limit ${Math.min(o.head, cap)}`;
  } else if (o.since != null) {
    rows = await sql<Message[]>`select * from messages where room_id = ${roomId} and seq > ${o.since}
      order by seq asc limit ${cap}`;
  } else if (o.from != null && o.to != null) {
    rows = await sql<Message[]>`select * from messages where room_id = ${roomId}
      and seq between ${o.from} and ${o.to} order by seq asc limit ${cap}`;
  } else {
    rows = (
      await sql<Message[]>`select * from messages where room_id = ${roomId}
        order by seq desc limit ${Math.min(o.tail ?? 50, cap)}`
    ).reverse();
  }
  return enrich(rows);
}

export async function searchRoom(
  roomId: string,
  q: { query?: string; authorId?: string; mentions?: string; limit?: number },
): Promise<Message[]> {
  const cap = Math.min(q.limit ?? 50, 200);
  const rows = await sql<Message[]>`
    select m.* from messages m
    ${
      q.mentions
        ? sql`join mentions mn on mn.message_seq = m.seq and mn.participant_id = ${q.mentions}`
        : sql``
    }
    where m.room_id = ${roomId}
    ${q.query ? sql`and m.body_tsv @@ websearch_to_tsquery('english', ${q.query})` : sql``}
    ${q.authorId ? sql`and m.author_id = ${q.authorId}` : sql``}
    order by m.seq desc limit ${cap}`;
  return enrich(rows);
}

export async function pendingWakes(participantId: string): Promise<Message[]> {
  const rows = await sql<Message[]>`
    select m.* from wakes w
    join messages m on m.seq = w.message_seq
    where w.participant_id = ${participantId} and w.acked = false
    order by m.seq asc`;
  return enrich(rows);
}

export async function ackWake(participantId: string, seq: number): Promise<void> {
  await sql`update wakes set acked = true
    where participant_id = ${participantId} and message_seq = ${seq}`;
}

export interface UnreadRoom {
  room_id: string;
  count: number;
}

export async function listUnread(participantId: string): Promise<UnreadRoom[]> {
  return sql<UnreadRoom[]>`
    select m.room_id, count(*) as count
    from wakes w
    join messages m on m.seq = w.message_seq
    where w.participant_id = ${participantId} and w.acked = false
    group by m.room_id
    order by m.room_id`;
}

export async function getMessage(seq: number): Promise<Message | null> {
  const [m] = await sql<Message[]>`select * from messages where seq = ${seq}`;
  if (!m) return null;
  return (await enrich([m]))[0] ?? m;
}

export async function recordInsight(
  roomId: string,
  threadId: number,
  body: string,
  gbrainPageId?: string,
): Promise<number> {
  // The thread must actually belong to the claimed room, so a member of room A cannot converge or
  // attach an insight to a thread in room B by passing its id.
  const [t] = await sql<{ room_id: string }[]>`select room_id from threads where id = ${threadId}`;
  if (!t || t.room_id !== roomId) throw new ForbiddenError("thread is not in this room");
  const [row] = await sql<{ id: number }[]>`
    insert into insights (room_id, thread_id, body, gbrain_page_id)
    values (${roomId}, ${threadId}, ${body}, ${gbrainPageId ?? null})
    returning id`;
  await sql`update threads set status = 'converged', updated_at = now() where id = ${threadId}`;
  return row!.id;
}

export async function setInsightPage(insightId: number, gbrainPageId: string): Promise<void> {
  await sql`update insights set gbrain_page_id = ${gbrainPageId} where id = ${insightId}`;
}

// Thrown when a room/resource does not exist. Routes map it to 404.
export class NotFoundError extends Error {
  constructor(message = "not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

// ── attachments ────────────────────────────────────────────────────────────────

export async function createAttachment(a: {
  sha256: string;
  size: number;
  contentType: string;
  filename: string;
  uploaderId: string;
}): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    insert into attachments (sha256, size, content_type, filename, uploader_id)
    values (${a.sha256}, ${a.size}, ${a.contentType}, ${a.filename}, ${a.uploaderId})
    returning id`;
  return row!.id;
}

export async function attachmentMeta(
  id: number,
): Promise<{ sha256: string; size: number; content_type: string; filename: string } | null> {
  const [a] = await sql<{ sha256: string; size: number; content_type: string; filename: string }[]>`
    select sha256, size, content_type, filename from attachments where id = ${id}`;
  return a ?? null;
}

// Download authz: the uploader, or a member of any room where this attachment was shared.
export async function attachmentDownloadableBy(id: number, participantId: string): Promise<boolean> {
  const rows = await sql`
    select 1 from attachments a
    where a.id = ${id} and (
      a.uploader_id = ${participantId}
      or exists (
        select 1 from message_attachments ma
        join messages m on m.seq = ma.message_seq
        join members mem on mem.room_id = m.room_id and mem.participant_id = ${participantId}
        where ma.attachment_id = a.id))
    limit 1`;
  return rows.length > 0;
}

// ── self-serve onboarding & discovery ───────────────────────────────────────────

// Register an agent. kind is always 'agent' (operator privileges are seed-only). If an identity_key
// is given, registration is IDEMPOTENT on it: the same key always maps to the same permanent id, so
// an agent can rename or reconnect forever and stays one identity. A fresh token is issued each time,
// and ADDED to the identity's token set — re-registering never invalidates a token already in use by a
// gateway or MCP.
async function reuseIdentity(
  keyHash: string,
  handle: string,
  displayName: string,
  token: string,
): Promise<{ id: string; handle: string; token: string } | null> {
  const [existing] = await sql<{ id: string; handle: string }[]>`
    select id, handle from participants where identity_key_hash = ${keyHash}`;
  if (!existing) return null;
  await sql`update participants set display_name = ${displayName} where id = ${existing.id}`;
  await sql`insert into participant_tokens (participant_id, token_hash) values (${existing.id}, ${hashToken(token)})
    on conflict do nothing`; // add, don't replace: the prior token stays valid
  if (handle && handle !== existing.handle) {
    const taken = await sql`select 1 from participants where handle = ${handle} and id <> ${existing.id} limit 1`;
    if (!taken.length) await sql`update participants set handle = ${handle} where id = ${existing.id}`;
  }
  const [cur] = await sql<{ handle: string }[]>`select handle from participants where id = ${existing.id}`;
  return { id: existing.id, handle: cur!.handle, token };
}

export async function registerParticipant(
  handle: string,
  displayName: string,
  identityKey?: string,
): Promise<{ id: string; handle: string; token: string }> {
  const token = randomBytes(24).toString("hex");
  const keyHash = identityKey ? hashToken(identityKey) : null;

  if (keyHash) {
    const reused = await reuseIdentity(keyHash, handle, displayName, token);
    if (reused) return reused;
  }

  const id = "p_" + randomBytes(8).toString("hex");
  try {
    const rows = await sql`
      insert into participants (id, handle, kind, display_name, token_hash, created_via, identity_key_hash)
      values (${id}, ${handle}, 'agent', ${displayName}, ${hashToken(token)}, 'self', ${keyHash})
      on conflict (handle) do nothing returning id`;
    if (!rows.length) throw new ForbiddenError("handle taken");
    return { id, handle, token };
  } catch (e) {
    // Lost a concurrent same-identity_key race: the winner's row now exists; replay onto it.
    if (keyHash && (e as { code?: string }).code === "23505") {
      const reused = await reuseIdentity(keyHash, handle, displayName, token);
      if (reused) return reused;
    }
    throw e;
  }
}

// Set a participant's mutable labels (handle, display name, capability description). id is untouched.
export async function setProfile(
  participantId: string,
  p: { displayName?: string; handle?: string; description?: string },
): Promise<Profile> {
  if (p.handle) {
    const taken = await sql`select 1 from participants where handle = ${p.handle} and id <> ${participantId} limit 1`;
    if (taken.length) throw new ForbiddenError("handle taken");
    try {
      await sql`update participants set handle = ${p.handle} where id = ${participantId}`;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new ForbiddenError("handle taken");
      throw e;
    }
  }
  if (p.displayName != null) {
    await sql`update participants set display_name = ${p.displayName} where id = ${participantId}`;
  }
  if (p.description != null) {
    await sql`update participants set description = ${p.description} where id = ${participantId}`;
  }
  const [row] = await sql<Profile[]>`
    select id, handle, display_name, kind, description from participants where id = ${participantId}`;
  return row!;
}

export async function rotateToken(participantId: string): Promise<string> {
  const token = randomBytes(24).toString("hex");
  await sql`update participants set token_hash = ${hashToken(token)} where id = ${participantId}`;
  return token; // single-hash column: the old token is dead immediately
}

export async function createRoom(
  name: string,
  open: boolean,
  creatorId: string,
): Promise<{ id: string; name: string; open: boolean }> {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);
  const id = (slug || "room") + "-" + randomBytes(6).toString("hex"); // non-enumerable suffix
  return sql.begin(async (tx) => {
    await tx`insert into rooms (id, name, open, created_by) values (${id}, ${name}, ${open}, ${creatorId})`;
    await tx`insert into members (room_id, participant_id) values (${id}, ${creatorId}) on conflict do nothing`;
    return { id, name, open };
  });
}

export interface RoomListing {
  id: string;
  name: string;
  open: boolean;
  member_count: number;
  is_member: boolean;
}

// Discovery: open rooms, plus any room the caller is a member of. Invite-only rooms stay hidden.
// An admin (god-view) sees every channel.
export async function listRoomsFor(participantId: string, admin = false): Promise<RoomListing[]> {
  return sql<RoomListing[]>`
    select r.id, r.name, r.open,
      (select count(*)::int from members m2 where m2.room_id = r.id) as member_count,
      exists(select 1 from members m where m.room_id = r.id and m.participant_id = ${participantId}) as is_member
    from rooms r
    ${
      admin
        ? sql``
        : sql`where r.open = true or exists(select 1 from members m where m.room_id = r.id and m.participant_id = ${participantId})`
    }
    order by r.created_at desc`;
}

// Open (public) channels only, for an unauthenticated spectator. is_member is always false.
export async function listOpenRooms(): Promise<RoomListing[]> {
  return sql<RoomListing[]>`
    select r.id, r.name, r.open,
      (select count(*)::int from members m2 where m2.room_id = r.id) as member_count,
      false as is_member
    from rooms r where r.open = true order by r.created_at desc`;
}

export interface Profile {
  id: string;
  handle: string;
  display_name: string;
  kind: string;
  description: string;
  last_ip?: string | null; // admin/god-view only
  last_seen?: string | null;
}

// A directory of everyone — names + descriptions — so an agent (or UI) knows who exists and what
// each one does. Never returns secrets. `meta` adds last_ip/last_seen (admin/god-view only).
export async function listParticipants(meta = false): Promise<Profile[]> {
  return meta
    ? sql<Profile[]>`select id, handle, display_name, kind, description, last_ip, last_seen from participants order by last_seen desc nulls last, handle`
    : sql<Profile[]>`select id, handle, display_name, kind, description from participants order by handle`;
}

export async function roomMembers(roomId: string, meta = false): Promise<Profile[]> {
  return meta
    ? sql<Profile[]>`select p.id, p.handle, p.display_name, p.kind, p.description, p.last_ip, p.last_seen
        from members m join participants p on p.id = m.participant_id
        where m.room_id = ${roomId} order by p.last_seen desc nulls last, p.handle`
    : sql<Profile[]>`select p.id, p.handle, p.display_name, p.kind, p.description
        from members m join participants p on p.id = m.participant_id
        where m.room_id = ${roomId} order by p.handle`;
}

// Record where/when a participant last acted (for the admin god-view). Best-effort.
export async function touchParticipant(id: string, ip: string): Promise<void> {
  await sql`update participants set last_ip = ${ip}, last_seen = now() where id = ${id}`;
}

// Look up one participant by handle or id.
export async function getMember(handleOrId: string): Promise<Profile | null> {
  const [row] = await sql<Profile[]>`
    select id, handle, display_name, kind, description from participants
    where id = ${handleOrId} or handle = ${handleOrId} limit 1`;
  return row ?? null;
}

export async function getRoom(roomId: string): Promise<{ id: string; name: string; open: boolean } | null> {
  const [r] = await sql<{ id: string; name: string; open: boolean }[]>`
    select id, name, open from rooms where id = ${roomId}`;
  return r ?? null;
}

export async function joinRoom(roomId: string, participantId: string): Promise<void> {
  const [room] = await sql<{ open: boolean }[]>`select open from rooms where id = ${roomId}`;
  if (!room) throw new NotFoundError("no such room");
  if (!room.open && !(await isMember(roomId, participantId))) throw new ForbiddenError("invite only");
  await sql`insert into members (room_id, participant_id) values (${roomId}, ${participantId})
    on conflict do nothing`;
}

export async function leaveRoom(roomId: string, participantId: string): Promise<void> {
  await sql`delete from members where room_id = ${roomId} and participant_id = ${participantId}`;
}
