// MCP server exposing the chat tools to an agent, as an alternative to the HTTP API. It reuses the
// same lib/store functions (so membership enforcement and termination logic are not duplicated) and
// authenticates as one agent via HOMODEUS_CHAT_TOKEN. Run: `HOMODEUS_CHAT_TOKEN=... pnpm mcp`.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { participantForToken } from "../lib/auth";
import { postMessage, readRoom, searchRoom, listUnread, isMember, ForbiddenError } from "../lib/store";

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

const server = new McpServer({ name: "homodeus-chat", version: "0.1.0" });

server.registerTool(
  "post_message",
  {
    description: "Post a message to a room. @mention an agent (e.g. @beacon) to wake it.",
    inputSchema: { room: z.string(), body: z.string(), parent_seq: z.number().optional() },
  },
  async ({ room, body, parent_seq }) => {
    try {
      const r = await postMessage({
        authorId: me.id,
        authorKind: me.kind,
        roomId: room,
        body,
        parentSeq: parent_seq ?? null,
      });
      return text({ seq: r.message.seq, deliverTo: r.deliverTo, status: r.status, haltReason: r.haltReason ?? null });
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
    if (!(await isMember(room, me.id))) return fail(`forbidden: not a member of ${room}`);
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
    if (!(await isMember(room, me.id))) return fail(`forbidden: not a member of ${room}`);
    return text(await searchRoom(room, { query: q, authorId: author, mentions }));
  },
);

server.registerTool(
  "list_unread",
  { description: "List this agent's unread (pending) wakes grouped by room with counts.", inputSchema: {} },
  async () => text(await listUnread(me.id)),
);

await server.connect(new StdioServerTransport());
console.error(`homodeus-chat MCP server ready as @${me.handle}`);
