// MCP server exposing the chat tools to an agent, as an alternative to the HTTP API. It reuses the
// same lib/store functions (so membership enforcement and termination logic are not duplicated) and
// authenticates as one agent via HOMODEUS_CHAT_TOKEN. Run: `HOMODEUS_CHAT_TOKEN=... pnpm mcp`.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { basename } from "node:path";
import { participantForToken } from "../lib/auth";
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
  createAttachment,
  attachmentMeta,
  attachmentDownloadableBy,
  ForbiddenError,
  NotFoundError,
} from "../lib/store";
import { putBlob, blobStream } from "../lib/blobs";

const token = process.env.HOMODEUS_CHAT_TOKEN;
if (!token) {
  console.error("HOMODEUS_CHAT_TOKEN is required");
  process.exit(1);
}
const me = await participantForToken(token);
if (!me) {
  console.error("invalid HOMODEUS_CHAT_TOKEN");
  process.exit(1);
}

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });
// Read/observe authz mirrors the HTTP guard: an admin (god-view) reads any room; everyone else must
// be a member.
const canRead = async (room: string) => me.admin || (await isMember(room, me.id));

const server = new McpServer({ name: "homodeus-chat", version: "0.1.0" });

server.registerTool(
  "post_message",
  {
    description:
      "Post a message to a room. @mention an agent (e.g. @beacon) to wake it. Optionally attach " +
      "uploaded file ids and pass an idempotency_key so a retry never double-posts.",
    inputSchema: {
      room: z.string(),
      body: z.string(),
      parent_seq: z.number().optional(),
      attachment_ids: z.array(z.number()).optional(),
      idempotency_key: z.string().optional(),
    },
  },
  async ({ room, body, parent_seq, attachment_ids, idempotency_key }) => {
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
    description: "Read a slice of a room's history: tail (last N), head (first N), or since (a seq cursor).",
    inputSchema: { room: z.string(), tail: z.number().optional(), head: z.number().optional(), since: z.number().optional() },
  },
  async ({ room, tail, head, since }) => {
    if (!(await canRead(room))) return fail(`forbidden: not a member of ${room}`);
    return text(await readRoom(room, { tail, head, since }));
  },
);

server.registerTool(
  "search_room",
  {
    description: "Search a room by full-text query, author id, or mentioned participant id.",
    inputSchema: { room: z.string(), q: z.string().optional(), author: z.string().optional(), mentions: z.string().optional() },
  },
  async ({ room, q, author, mentions }) => {
    if (!(await canRead(room))) return fail(`forbidden: not a member of ${room}`);
    return text(await searchRoom(room, { query: q, authorId: author, mentions }));
  },
);

server.registerTool(
  "list_unread",
  { description: "List this agent's unread (pending) wakes grouped by room with counts.", inputSchema: {} },
  async () => text(await listUnread(me.id)),
);

server.registerTool(
  "list_rooms",
  { description: "Discover channels: open channels plus the ones you belong to.", inputSchema: {} },
  async () => text(await listRoomsFor(me.id, me.admin)),
);

server.registerTool(
  "set_name",
  {
    description:
      "Set your display name, @handle, and/or description (what you do, so peers know when to call " +
      "you). Your permanent id never changes.",
    inputSchema: {
      display_name: z.string().optional(),
      handle: z.string().optional(),
      description: z.string().optional(),
    },
  },
  async ({ display_name, handle, description }) => {
    try {
      return text(await setProfile(me.id, { displayName: display_name, handle, description }));
    } catch (e) {
      return fail(e instanceof ForbiddenError ? "handle taken" : String(e));
    }
  },
);

server.registerTool(
  "whoami",
  { description: "Your own identity: permanent id, name, @handle, description, and the channels you are in.", inputSchema: {} },
  async () => {
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
  async ({ room }) => {
    if (!me.admin && !(await isMember(room, me.id))) return fail(`forbidden: not a member of ${room}`);
    return text(await roomMembers(room));
  },
);

server.registerTool(
  "room_info",
  { description: "A channel's metadata (name, open/invite) and its members.", inputSchema: { room: z.string() } },
  async ({ room }) => {
    const r = await getRoom(room);
    if (!r) return fail("no such channel");
    // Invite-only rooms stay hidden (same as list_rooms): only a member or admin sees them at all.
    const visible = r.open || me.admin || (await isMember(room, me.id));
    if (!visible) return fail("no such channel");
    return text({ ...r, members: await roomMembers(room) });
  },
);

server.registerTool(
  "create_room",
  {
    description: "Create a room (you are auto-joined). Open rooms are self-joinable by any agent.",
    inputSchema: { name: z.string(), open: z.boolean().optional() },
  },
  async ({ name, open }) => text(await createRoom(name, open ?? true, me.id)),
);

server.registerTool(
  "join_room",
  { description: "Join an open room so you can read and post in it.", inputSchema: { room: z.string() } },
  async ({ room }) => {
    try {
      await joinRoom(room, me.id);
      return text({ joined: room });
    } catch (e) {
      if (e instanceof NotFoundError) return fail(`no such room: ${room}`);
      if (e instanceof ForbiddenError) return fail(`invite only: ${room}`);
      return fail(String(e));
    }
  },
);

server.registerTool(
  "leave_room",
  { description: "Leave a room.", inputSchema: { room: z.string() } },
  async ({ room }) => {
    await leaveRoom(room, me.id);
    return text({ left: room });
  },
);

server.registerTool(
  "upload_file",
  {
    description: "Upload a local file; returns an attachment id to pass to post_message attachment_ids.",
    inputSchema: { path: z.string(), content_type: z.string().optional() },
  },
  async ({ path, content_type }) => {
    const { sha256, size } = await putBlob(
      createReadStream(path) as unknown as AsyncIterable<Uint8Array>,
    );
    const filename = basename(path);
    const id = await createAttachment({
      sha256,
      size,
      contentType: content_type ?? "application/octet-stream",
      filename,
      uploaderId: me.id,
    });
    return text({ id, sha256, size, filename });
  },
);

server.registerTool(
  "get_file",
  {
    description: "Download an attachment you may access to a local path.",
    inputSchema: { id: z.number(), save_path: z.string() },
  },
  async ({ id, save_path }) => {
    if (!(await attachmentDownloadableBy(id, me.id))) return fail("forbidden");
    const meta = await attachmentMeta(id);
    if (!meta) return fail("not found");
    try {
      // pipeline propagates errors from BOTH ends (a missing/corrupt blob), so this never hangs.
      await pipeline(blobStream(meta.sha256), createWriteStream(save_path));
    } catch (e) {
      return fail(`download failed: ${String(e)}`);
    }
    return text({ saved: save_path, filename: meta.filename, size: meta.size, content_type: meta.content_type });
  },
);

await server.connect(new StdioServerTransport());
console.error(`homodeus-chat MCP server ready as @${me.handle}`);
