import { randomBytes, createHash } from "node:crypto";
import postgres from "postgres";
import { DB_URL } from "../lib/config";

const sql = postgres(DB_URL, { max: 1, connection: { search_path: "chat" } });
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const mkToken = () => randomBytes(24).toString("hex");

// Default channels (Slack-style). general/random are open (self-joinable + discoverable).
const channels: { id: string; name: string; open: boolean }[] = [
  { id: "general", name: "general", open: true },
  { id: "random", name: "random", open: true },
  { id: "ops", name: "ops", open: false },
];

const participants: {
  id: string;
  handle: string;
  kind: "agent" | "human";
  name: string;
  desc: string;
  admin: boolean;
  join: string[];
}[] = [
  { id: "p_crm", handle: "crm", kind: "agent", name: "CRM Agent", desc: "Reads sales calls and writes follow-ups. @mention me for anything about deals, leads, or call summaries.", admin: false, join: ["general", "ops"] },
  { id: "p_beacon", handle: "beacon", kind: "agent", name: "Beacon", desc: "Watches the pipeline and deal stages. @mention me to check or update where a deal stands.", admin: false, join: ["general", "ops"] },
  { id: "p_joao", handle: "joao", kind: "human", name: "Joao", desc: "Human operator and observer.", admin: true, join: [] },
];

for (const c of channels) {
  await sql`insert into rooms (id, name, open) values (${c.id}, ${c.name}, ${c.open})
    on conflict (id) do update set name = excluded.name, open = excluded.open`;
}

const tokens: Record<string, string> = {};
for (const p of participants) {
  const token = mkToken();
  tokens[p.handle] = token;
  await sql`
    insert into participants (id, handle, kind, display_name, token_hash, admin, description)
    values (${p.id}, ${p.handle}, ${p.kind}, ${p.name}, ${hash(token)}, ${p.admin}, ${p.desc})
    on conflict (id) do update set
      token_hash = excluded.token_hash, admin = excluded.admin, description = excluded.description`;
  for (const ch of p.join) {
    await sql`insert into members (room_id, participant_id) values (${ch}, ${p.id}) on conflict do nothing`;
  }
}

await sql.end();
console.log("seeded channels:", channels.map((c) => c.id).join(", "));
console.log("\ntokens (store these — only shown now):");
for (const [handle, token] of Object.entries(tokens)) {
  const admin = participants.find((p) => p.handle === handle)?.admin ? "  (admin/observer)" : "";
  console.log(`  ${handle.padEnd(8)} ${token}${admin}`);
}
