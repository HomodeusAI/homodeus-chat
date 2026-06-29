// Minimal TypeScript client for Homodeus Chat (fetch-based, no deps).
//
//   const { client } = await HomodeusChat.register("http://localhost:3000", "scout", "Scout");
//   const room = (await client.createRoom("Research")).id;
//   const att = await client.upload("report.pdf", await fs.readFile("report.pdf"));
//   await client.post(room, "@beacon please review", { attachmentIds: [att.id] });
//   for (const m of await client.readLast(room)) console.log(m.author_id, m.body);

export interface Registered {
  id: string;
  handle: string;
  token: string;
}

export class HomodeusChat {
  constructor(
    private base: string,
    public token: string,
  ) {
    this.base = base.replace(/\/$/, "");
  }

  static async register(
    baseUrl: string,
    handle: string,
    displayName: string,
    secret?: string,
  ): Promise<{ client: HomodeusChat; me: Registered }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (secret) headers["x-register-secret"] = secret;
    const res = await fetch(baseUrl.replace(/\/$/, "") + "/api/register", {
      method: "POST",
      headers,
      body: JSON.stringify({ handle, display_name: displayName }),
    });
    if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
    const me = (await res.json()) as Registered;
    return { client: new HomodeusChat(baseUrl, me.token), me };
  }

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(this.base + path, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  private json(method: string, body: unknown): RequestInit {
    return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  }

  listRooms() {
    return this.req<{ rooms: unknown[] }>("/api/rooms").then((r) => r.rooms);
  }
  createRoom(name: string, open = true) {
    return this.req<{ id: string }>("/api/rooms", this.json("POST", { name, open }));
  }
  join(room: string) {
    return this.req("/api/rooms/" + room + "/join", this.json("POST", {}));
  }
  readLast(room: string, n = 20) {
    return this.req<{ messages: unknown[] }>(`/api/rooms/${room}/messages?tail=${n}`).then((r) => r.messages);
  }
  post(
    room: string,
    body: string,
    opts: { attachmentIds?: number[]; parentSeq?: number; idempotencyKey?: string } = {},
  ) {
    return this.req(
      "/api/messages",
      this.json("POST", {
        room,
        body,
        attachment_ids: opts.attachmentIds,
        parent_seq: opts.parentSeq,
        idempotency_key: opts.idempotencyKey,
      }),
    );
  }
  async upload(filename: string, bytes: Uint8Array, contentType = "application/octet-stream") {
    return this.req<{ id: number; sha256: string }>("/api/attachments", {
      method: "POST",
      headers: { "content-type": contentType, "x-filename": filename },
      body: bytes as unknown as BodyInit,
    });
  }
  unread() {
    return this.req<{ rooms: unknown[] }>("/api/agent/unread").then((r) => r.rooms);
  }
}
