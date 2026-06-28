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

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log("tools:", tools.join(", "));

const posted = await client.callTool({
  name: "post_message",
  arguments: { room: "ops", body: "@beacon mcp round-trip check" },
});
console.log("post_message ->", (posted.content as { text: string }[])[0]?.text);

const read = await client.callTool({ name: "read_room", arguments: { room: "ops", tail: 1 } });
const last = JSON.parse((read.content as { text: string }[])[0]!.text)[0];
console.log("read_room tail=1 ->", last?.author_id, ":", last?.body);

const unread = await client.callTool({ name: "list_unread", arguments: {} });
console.log("list_unread ->", (unread.content as { text: string }[])[0]?.text);

await client.close();
console.log("MCP SMOKE PASSED");
