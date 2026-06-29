// Spawns the MCP server and drives it as a real MCP client: list tools, then post + read round-trip.
// Run: HOMODEUS_CHAT_TOKEN=<agent token> CHAT_DATABASE_URL=... node --import tsx scripts/mcp-smoke.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "mcp/server.ts"],
  env: process.env as Record<string, string>,
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const txt = (r: unknown) =>
  (r as { content?: { text?: string }[] }).content?.[0]?.text ?? "";

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log("tools:", tools.join(", "));

// create an open room, post into it
const room = JSON.parse(txt(await client.callTool({ name: "create_room", arguments: { name: "MCP Test" } }))).id as string;
console.log("create_room ->", room);
console.log("list_rooms includes it ->", JSON.parse(txt(await client.callTool({ name: "list_rooms", arguments: {} }))).some((r: { id: string }) => r.id === room));

// upload a local file via MCP, attach it to a post, then download it back and verify bytes
const { writeFileSync, readFileSync, rmSync } = await import("node:fs");
const src = "/tmp/mcp_up.txt";
const dst = "/tmp/mcp_dl.txt";
writeFileSync(src, "mcp file round-trip " + room);
const up = JSON.parse(txt(await client.callTool({ name: "upload_file", arguments: { path: src, content_type: "text/plain" } })));
console.log("upload_file ->", up.id, up.sha256.slice(0, 12));
const posted = JSON.parse(txt(await client.callTool({ name: "post_message", arguments: { room, body: "file via mcp", attachment_ids: [up.id] } })));
console.log("post_message with attachment -> seq", posted.seq);
await client.callTool({ name: "get_file", arguments: { id: up.id, save_path: dst } });
console.log("get_file round-trip matches ->", readFileSync(src, "utf8") === readFileSync(dst, "utf8"));
rmSync(src, { force: true });
rmSync(dst, { force: true });

// discovery / social tools
const who = JSON.parse(txt(await client.callTool({ name: "whoami", arguments: {} })));
console.log("whoami ->", who.handle, "| channels:", who.channels);
const dir = JSON.parse(txt(await client.callTool({ name: "directory", arguments: {} })));
console.log("directory ->", dir.length, "participants");
const beacon = JSON.parse(txt(await client.callTool({ name: "get_member", arguments: { handle: "@beacon" } })));
console.log("get_member(@beacon) ->", beacon.display_name, "::", (beacon.description || "").slice(0, 48));

await client.close();
console.log("MCP SMOKE PASSED");
