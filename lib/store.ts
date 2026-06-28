import { sql } from "./db";
import { BUDGET, PAIR_WAKES_PER_MIN } from "./config";
import { extractMentionHandles, resolveMentions } from "./mentions";
import { decideDelivery, type Ledger, type ThreadStatus } from "./threads";
import { minuteBucket, splitByCooldown } from "./cooldown";

export interface Message {
  seq: number;
  room_id: string;
  author_id: string;
  body: string;
  thread_id: number;
  parent_seq: number | null;
  depth: number;
  tokens: number | null;
  cost_usd: string | null;
  created_at: string;
}

export interface PostInput {
  authorId: string;
  authorKind: "agent" | "human";
  roomId: string;
  body: string;
  parentSeq?: number | null;
  tokens?: number;
  costUsd?: number;
}

export interface PostResult {
  message: Message;
  deliverTo: string[];
  haltReason?: string;
  status: ThreadStatus;
  mentionedAgentIds: string[];
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

    const handles = extractMentionHandles(input.body);
    const { resolved } = resolveMentions(handles, handleToId, input.authorId);
    const mentionedAgentIds = resolved.filter((id) => agentIds.has(id));

    let threadId: number | null = null;
    let depth = 0;
    if (input.parentSeq != null) {
      const [parent] = await tx<{ thread_id: number; depth: number }[]>`
        select thread_id, depth from messages where seq = ${input.parentSeq}`;
      if (parent) {
        threadId = parent.thread_id;
        depth = parent.depth + 1;
      }
    }

    const [msg] = await tx<Message[]>`
      insert into messages (room_id, author_id, body, thread_id, parent_seq, depth, tokens, cost_usd)
      values (${input.roomId}, ${input.authorId}, ${input.body}, ${threadId},
              ${input.parentSeq ?? null}, ${depth}, ${input.tokens ?? null}, ${input.costUsd ?? null})
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

    const [thread] = await tx<
      { turn_count: number; token_count: string; cost_usd: string; status: ThreadStatus }[]
    >`
      insert into threads (id, room_id) values (${threadId}, ${input.roomId})
      on conflict (id) do update set updated_at = now()
      returning turn_count, token_count, cost_usd, status`;
    if (!thread) throw new Error("thread upsert failed");

    const prev: Ledger = {
      turnCount: thread.turn_count,
      tokenCount: Number(thread.token_count),
      costUsd: Number(thread.cost_usd),
      status: thread.status,
    };

    const decision = decideDelivery(
      prev,
      {
        authorKind: input.authorKind,
        mentionedAgentIds,
        tokens: input.tokens,
        costUsd: input.costUsd,
      },
      BUDGET,
    );

    await tx`update threads set
        turn_count = ${decision.ledger.turnCount},
        token_count = ${decision.ledger.tokenCount},
        cost_usd = ${decision.ledger.costUsd},
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

    return {
      message: msg,
      deliverTo,
      haltReason: decision.haltReason,
      status: decision.ledger.status,
      mentionedAgentIds,
    };
  });
}

export interface ReadOpts {
  tail?: number;
  head?: number;
  since?: number;
  from?: number;
  to?: number;
  limit?: number;
}

export async function readRoom(roomId: string, o: ReadOpts): Promise<Message[]> {
  const cap = Math.min(o.limit ?? 200, 500);
  if (o.head != null) {
    return sql<Message[]>`select * from messages where room_id = ${roomId}
      order by seq asc limit ${Math.min(o.head, cap)}`;
  }
  if (o.since != null) {
    return sql<Message[]>`select * from messages where room_id = ${roomId} and seq > ${o.since}
      order by seq asc limit ${cap}`;
  }
  if (o.from != null && o.to != null) {
    return sql<Message[]>`select * from messages where room_id = ${roomId}
      and seq between ${o.from} and ${o.to} order by seq asc limit ${cap}`;
  }
  const rows = await sql<Message[]>`select * from messages where room_id = ${roomId}
    order by seq desc limit ${Math.min(o.tail ?? 50, cap)}`;
  return rows.reverse();
}

export async function searchRoom(
  roomId: string,
  q: { query?: string; authorId?: string; mentions?: string; limit?: number },
): Promise<Message[]> {
  const cap = Math.min(q.limit ?? 50, 200);
  return sql<Message[]>`
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
}

export async function pendingWakes(participantId: string): Promise<Message[]> {
  return sql<Message[]>`
    select m.* from wakes w
    join messages m on m.seq = w.message_seq
    where w.participant_id = ${participantId} and w.acked = false
    order by m.seq asc`;
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
  return m ?? null;
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
