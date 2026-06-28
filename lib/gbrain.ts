import { spawn } from "node:child_process";

// Boundary for pushing a converged thread's insight into gbrain (the company brain) as a page.
// The Next backend cannot call MCP, so this shells to the gbrain CLI (`gbrain put <slug>` reads
// markdown from stdin). Best-effort and opt-in: it no-ops unless CHAT_GBRAIN_SYNC=1, so tests and
// local dev never shell out. A failure returns null; the insight is still stored in Postgres.
const GBRAIN_BIN = process.env.GBRAIN_BIN ?? "/Users/joaopanizzutti/.local/bin/gbrain";

export async function pushInsightPage(
  roomId: string,
  threadId: number,
  body: string,
): Promise<string | null> {
  if (process.env.CHAT_GBRAIN_SYNC !== "1") return null;
  const slug = `chat/insights/${roomId}/${threadId}`;
  const md = `---\ntype: insight\nroom: ${roomId}\nthread: ${threadId}\n---\n\n${body}\n`;
  return new Promise((resolve) => {
    const child = spawn(GBRAIN_BIN, ["put", slug], { env: process.env });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? slug : null));
    child.stdin.end(md);
  });
}
