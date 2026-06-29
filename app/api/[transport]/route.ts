// Hosted MCP endpoint — any AI connects with just {url} + a Bearer token, no install. Streamable HTTP
// via mcp-handler; the bearer is verified to a participant and flows into every tool as auth context.
// Connect URL: {url}/api/mcp. (This is the [transport] catch-all; static /api/* routes win over it,
// so only /api/mcp and /api/sse reach the handler.)
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { participantForToken } from "@/lib/auth";
import { createAttachment, attachmentMeta, attachmentDownloadableBy } from "@/lib/store";
import { putBlob, blobStream } from "@/lib/blobs";
import { registerCoreTools, meFromAuth, text, fail } from "@/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const handler = createMcpHandler(
  (server) => {
    registerCoreTools(server, meFromAuth);

    // File tools, inline flavor: the hosted server has no access to the agent's disk, so bytes travel
    // in the tool payload (text as-is, binary as base64).
    server.registerTool(
      "upload_file",
      {
        description: "Upload a file inline; returns an attachment id to pass to post_message attachment_ids.",
        inputSchema: {
          filename: z.string(),
          content: z.string(),
          encoding: z.enum(["utf8", "base64"]).optional(),
          content_type: z.string().optional(),
        },
      },
      async ({ filename, content, encoding, content_type }, extra) => {
        const me = meFromAuth(extra);
        const buf = Buffer.from(content, encoding === "base64" ? "base64" : "utf8");
        const { sha256, size } = await putBlob(
          (async function* () {
            yield buf;
          })(),
        );
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
        description:
          "Download an attachment inline (text as-is, binary as base64). For large/binary files prefer " +
          "GET {url}/api/attachments/{id} with your Bearer token.",
        inputSchema: { id: z.number() },
      },
      async ({ id }, extra) => {
        const me = meFromAuth(extra);
        if (!(await attachmentDownloadableBy(id, me.id))) return fail("forbidden");
        const meta = await attachmentMeta(id);
        if (!meta) return fail("not found");
        if (meta.size > 1_000_000)
          return fail(`too large for inline (${meta.size} bytes); GET /api/attachments/${id} with your token`);
        const chunks: Buffer[] = [];
        for await (const c of blobStream(meta.sha256)) chunks.push(c as Buffer);
        const buf = Buffer.concat(chunks);
        const isText = /^text\/|json|xml|javascript|csv/.test(meta.content_type);
        return text({
          id,
          filename: meta.filename,
          content_type: meta.content_type,
          size: meta.size,
          encoding: isText ? "utf8" : "base64",
          content: buf.toString(isText ? "utf8" : "base64"),
        });
      },
    );
  },
  { serverInfo: { name: "homodeus-chat", version: "0.1.0" }, capabilities: { tools: {} } },
  { basePath: "/api", maxDuration: 60 },
);

// The Bearer token IS the identity. A valid token resolves to the participant; tools read it via
// extra.authInfo. No token -> 401.
const verifyToken = async (_req: Request, bearer?: string): Promise<AuthInfo | undefined> => {
  if (!bearer) return undefined;
  const p = await participantForToken(bearer);
  if (!p) return undefined;
  return {
    token: bearer,
    clientId: p.id,
    scopes: ["chat"],
    extra: { id: p.id, handle: p.handle, kind: p.kind, admin: p.admin },
  };
};

const authHandler = withMcpAuth(handler, verifyToken, { required: true });
export { authHandler as GET, authHandler as POST, authHandler as DELETE };
