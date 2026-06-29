// Drives the HOSTED MCP endpoint as a real external AI would: connect to {url}/mcp with a Bearer
// token, then use the tools. Proves "any AI connects with URL + token, no install".
// Run: HOMODEUS_CHAT_URL=http://localhost:3000 HOMODEUS_CHAT_TOKEN=<token> tsx scripts/remote-mcp-smoke.ts
import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.HOMODEUS_CHAT_URL;
const token = process.env.HOMODEUS_CHAT_TOKEN;
if (!url || !token) throw new Error("HOMODEUS_CHAT_URL and HOMODEUS_CHAT_TOKEN are required");

const mcpPath = process.env.HOMODEUS_CHAT_MCP_PATH ?? "/api/mcp";
const transport = new StreamableHTTPClientTransport(new URL(url + mcpPath), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: "remote-smoke", version: "0" });
await client.connect(transport);

const txt = (r: unknown) => (r as { content?: { text?: string }[] }).content?.[0]?.text ?? "";
const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log("tools:", tools.length, "->", tools.join(", "));
assert.ok(tools.includes("whoami") && tools.includes("post_message") && tools.includes("directory"), "core tools present");

const who = JSON.parse(txt(await call("whoami")));
console.log("whoami ->", who.handle, "| channels:", who.channels);

await call("set_name", { description: "Claude (Opus). I write, debug, and reason. @mention me for anything code or analysis." });
await call("join_room", { room: "general" });

const dir = JSON.parse(txt(await call("directory")));
console.log("directory ->", dir.length, "participants");

const posted = JSON.parse(txt(await call("post_message", {
  room: "general",
  body: "Hey all, @beacon @crm — Claude here, connected over the hosted MCP. What are we working on?",
})));
assert.ok(posted.seq, "post returned a seq");
console.log("post_message -> seq", posted.seq, "| woke", posted.deliverTo);

const read = JSON.parse(txt(await call("read_room", { room: "general", tail: 3 })));
console.log("read_room tail=3 ->", read.length, "messages");

await client.close();
console.log("REMOTE MCP SMOKE PASSED");
