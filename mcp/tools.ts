// The chat + discovery tools, shared by the stdio MCP server and the hosted HTTP MCP endpoint. They
// reuse lib/store directly (membership + termination logic is never duplicated). File tools differ by
// transport (local paths vs inline content), so they live in each entry point, not here.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  postMessage,
  readRoom,
  searchRoom,
  listUnread,
  isMember,
  listRoomsFor,
  listParticipants,
  getMember,
  roomMembers,
  getRoom,
  createRoom,
  joinRoom,
  leaveRoom,
  setProfile,
  ForbiddenError,
  NotFoundError,
} from "../lib/store";

export interface Me {
  id: string;
  handle: string;
  kind: "agent" | "human";
  admin: boolean;
}

// Resolve the calling agent: a constant for the single-token stdio server, or per-request auth info
// for the multi-tenant HTTP endpoint.
export type ResolveMe = (extra: unknown) => Me;

export function meFromAuth(extra: unknown): Me {
  const info = (extra as { authInfo?: { extra?: Me } })?.authInfo?.extra;
  if (!info) throw new Error("unauthenticated");
  return info;
}

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });
const canRead = async (me: Me, room: string) => me.admin || (await isMember(room, me.id));

export function registerCoreTools(server: McpServer, resolveMe: ResolveMe): void {
  server.registerTool(
    "whoami",
    { description: "Your own identity: permanent id, name, @handle, description, and the channels you are in.", inputSchema: {} },
    async (_args, extra) => {
      const me = resolveMe(extra);
      const profile = await getMember(me.id);
      const channels = (await listRoomsFor(me.id, me.admin)).filter((r) => r.is_member).map((r) => r.id);
      return text({ ...(profile ?? { id: me.id, handle: me.handle }), channels });
    },
  );

  server.registerTool(
    "directory",
    {
      description:
        "Everyone in the system: handle, display name, kind (agent/human), and what each one does. " +
        "Use this to find the right peer to @mention for a task.",
      inputSchema: {},
    },
    async () => text(await listParticipants()),
  );

  server.registerTool(
    "get_member",
    {
      description: "Look up one participant by @handle or id: their name, kind, and capability description.",
      inputSchema: { handle: z.string() },
    },
    async ({ handle }) => {
      const m = await getMember(handle.replace(/^@/, ""));
      return m ? text(m) : fail("no such member");
    },
  );

  server.registerTool(
    "list_members",
    { description: "Who is in a channel, with each member's description.", inputSchema: { room: z.string() } },
    async ({ room }, extra) => {
      const me = resolveMe(extra);
      if (!(await canRead(me, room))) return fail(`forbidden: not a member of ${room}`);
      return text(await roomMembers(room));
    },
  );

  server.registerTool(
    "room_info",
    { description: "A channel's metadata (name, open/invite) and its members.", inputSchema: { room: z.string() } },
    async ({ room }, extra) => {
      const me = resolveMe(extra);
      const r = await getRoom(room);
      if (!r) return fail("no such channel");
      if (!(r.open || (await canRead(me, room)))) return fail("no such channel"); // invite-only stays hidden
      return text({ ...r, members: await roomMembers(room) });
    },
  );

  server.registerTool(
    "list_rooms",
    { description: "Discover channels: open channels plus the ones you belong to.", inputSchema: {} },
    async (_args, extra) => {
      const me = resolveMe(extra);
      return text(await listRoomsFor(me.id, me.admin));
    },
  );

  server.registerTool(
    "set_name",
    {
      description:
        "Set your display name, @handle, and/or description (what you do, so peers know when to call " +
        "you). Your permanent id never changes.",
      inputSchema: { display_name: z.string().optional(), handle: z.string().optional(), description: z.string().optional() },
    },
    async ({ display_name, handle, description }, extra) => {
      const me = resolveMe(extra);
      try {
        return text(await setProfile(me.id, { displayName: display_name, handle, description }));
      } catch (e) {
        return fail(e instanceof ForbiddenError ? "handle taken" : String(e));
      }
    },
  );

  server.registerTool(
    "post_message",
    {
      description:
        "Post a message to a channel. @mention an agent (e.g. @beacon) to wake it. Optionally attach " +
        "uploaded file ids and pass an idempotency_key so a retry never double-posts. End your turn by " +
        "mentioning no one.",
      inputSchema: {
        room: z.string(),
        body: z.string(),
        parent_seq: z.number().optional(),
        attachment_ids: z.array(z.number()).optional(),
        idempotency_key: z.string().optional(),
      },
    },
    async ({ room, body, parent_seq, attachment_ids, idempotency_key }, extra) => {
      const me = resolveMe(extra);
      if (!body.trim() && !attachment_ids?.length)
        return fail("a non-empty body or at least one attachment is required");
      try {
        const r = await postMessage({
          authorId: me.id,
          authorKind: me.kind,
          roomId: room,
          body,
          parentSeq: parent_seq ?? null,
          attachmentIds: attachment_ids,
          idempotencyKey: idempotency_key,
        });
        return text({ seq: r.message.seq, deliverTo: r.deliverTo, status: r.status, haltReason: r.haltReason ?? null, replayed: r.replayed ?? false });
      } catch (e) {
        return fail(e instanceof ForbiddenError ? `forbidden: not a member of ${room}` : String(e));
      }
    },
  );

  server.registerTool(
    "read_room",
    {
      description: "Read a slice of a channel's history: tail (last N), head (first N), or since (a seq cursor).",
      inputSchema: { room: z.string(), tail: z.number().optional(), head: z.number().optional(), since: z.number().optional() },
    },
    async ({ room, tail, head, since }, extra) => {
      const me = resolveMe(extra);
      if (!(await canRead(me, room))) return fail(`forbidden: not a member of ${room}`);
      return text(await readRoom(room, { tail, head, since }));
    },
  );

  server.registerTool(
    "search_room",
    {
      description: "Search a channel by full-text query, author id, or mentioned participant id.",
      inputSchema: { room: z.string(), q: z.string().optional(), author: z.string().optional(), mentions: z.string().optional() },
    },
    async ({ room, q, author, mentions }, extra) => {
      const me = resolveMe(extra);
      if (!(await canRead(me, room))) return fail(`forbidden: not a member of ${room}`);
      return text(await searchRoom(room, { query: q, authorId: author, mentions }));
    },
  );

  server.registerTool(
    "list_unread",
    { description: "List your unread (pending) wakes grouped by channel with counts.", inputSchema: {} },
    async (_args, extra) => text(await listUnread(resolveMe(extra).id)),
  );

  server.registerTool(
    "create_room",
    {
      description: "Create a channel (you are auto-joined). Open channels are self-joinable by any agent.",
      inputSchema: { name: z.string(), open: z.boolean().optional() },
    },
    async ({ name, open }, extra) => text(await createRoom(name, open ?? true, resolveMe(extra).id)),
  );

  server.registerTool(
    "join_room",
    { description: "Join an open channel so you can read and post in it.", inputSchema: { room: z.string() } },
    async ({ room }, extra) => {
      try {
        await joinRoom(room, resolveMe(extra).id);
        return text({ joined: room });
      } catch (e) {
        if (e instanceof NotFoundError) return fail(`no such channel: ${room}`);
        if (e instanceof ForbiddenError) return fail(`invite only: ${room}`);
        return fail(String(e));
      }
    },
  );

  server.registerTool(
    "leave_room",
    { description: "Leave a channel.", inputSchema: { room: z.string() } },
    async ({ room }, extra) => {
      await leaveRoom(room, resolveMe(extra).id);
      return text({ left: room });
    },
  );
}

export { text, fail };
