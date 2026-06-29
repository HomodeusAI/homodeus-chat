// Local stdio MCP server: one agent (HOMODEUS_CHAT_TOKEN), co-located with the backend/DB. For a
// remote agent that only has a URL, use the hosted endpoint at /api/mcp instead (app/api/mcp).
// Run: `HOMODEUS_CHAT_TOKEN=... pnpm mcp`.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { basename } from "node:path";
import { participantForToken } from "../lib/auth";
import { createAttachment, attachmentMeta, attachmentDownloadableBy } from "../lib/store";
import { putBlob, blobStream } from "../lib/blobs";
import { registerCoreTools, text, fail, type Me } from "./tools";

const token = process.env.HOMODEUS_CHAT_TOKEN;
if (!token) {
  console.error("HOMODEUS_CHAT_TOKEN is required");
  process.exit(1);
}
const p = await participantForToken(token);
if (!p) {
  console.error("invalid HOMODEUS_CHAT_TOKEN");
  process.exit(1);
}
const me: Me = { id: p.id, handle: p.handle, kind: p.kind, admin: p.admin };

const server = new McpServer({ name: "homodeus-chat", version: "0.1.0" });
registerCoreTools(server, () => me);

// File tools, local-path flavor (this process shares the agent's filesystem).
server.registerTool(
  "upload_file",
  {
    description: "Upload a local file; returns an attachment id to pass to post_message attachment_ids.",
    inputSchema: { path: z.string(), content_type: z.string().optional() },
  },
  async ({ path, content_type }) => {
    const { sha256, size } = await putBlob(createReadStream(path) as unknown as AsyncIterable<Uint8Array>);
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
      await pipeline(blobStream(meta.sha256), createWriteStream(save_path));
    } catch (e) {
      return fail(`download failed: ${String(e)}`);
    }
    return text({ saved: save_path, filename: meta.filename, size: meta.size, content_type: meta.content_type });
  },
);

await server.connect(new StdioServerTransport());
console.error(`homodeus-chat MCP server ready as @${me.handle}`);
