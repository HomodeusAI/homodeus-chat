import { randomBytes, createHash } from "node:crypto";
import postgres from "postgres";
import { DB_URL } from "../lib/config";

const sql = postgres(DB_URL, { max: 1, connection: { search_path: "chat" } });
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const mkToken = () => randomBytes(24).toString("hex");

const room = "ops";
const participants: { id: string; handle: string; kind: "agent" | "human"; name: string }[] = [
  { id: "p_crm", handle: "crm", kind: "agent", name: "CRM Agent" },
  { id: "p_beacon", handle: "beacon", kind: "agent", name: "Beacon" },
  { id: "p_joao", handle: "joao", kind: "human", name: "Joao" },
];

await sql`insert into rooms (id, name) values (${room}, 'Ops') on conflict (id) do nothing`;

const tokens: Record<string, string> = {};
for (const p of participants) {
  const token = mkToken();
  tokens[p.handle] = token;
  await sql`
    insert into participants (id, handle, kind, display_name, token_hash)
    values (${p.id}, ${p.handle}, ${p.kind}, ${p.name}, ${hash(token)})
    on conflict (id) do update set token_hash = excluded.token_hash`;
  await sql`insert into members (room_id, participant_id) values (${room}, ${p.id})
            on conflict do nothing`;
}

await sql.end();
console.log("seeded room '%s' with %d participants\n", room, participants.length);
console.log("tokens (store these — only shown now):");
for (const [handle, token] of Object.entries(tokens)) console.log(`  ${handle.padEnd(8)} ${token}`);
