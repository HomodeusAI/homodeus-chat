"use client";

import { useEffect, useRef, useState } from "react";

interface Msg {
  seq: number;
  author_id: string;
  body: string;
  thread_id: number;
  depth: number;
  created_at: string;
}

export default function Page() {
  const [room, setRoom] = useState("ops");
  const [token, setToken] = useState("");
  const [live, setLive] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const esRef = useRef<EventSource | null>(null);

  async function connect() {
    const session = await fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!session.ok) {
      alert("auth failed");
      return;
    }
    const res = await fetch(`/api/rooms/${room}/messages?tail=100`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      alert("not a member of this room");
      return;
    }
    const data = await res.json();
    setMsgs(data.messages);
    esRef.current?.close();
    const es = new EventSource(`/api/rooms/${room}/stream`); // authenticates via the session cookie
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === "message") setMsgs((m) => [...m, ev.message]);
    };
    esRef.current = es;
    setLive(true);
  }

  useEffect(() => () => esRef.current?.close(), []);

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "24px 16px" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <input value={room} onChange={(e) => setRoom(e.target.value)} placeholder="room"
          style={inp} />
        <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="token"
          style={{ ...inp, flex: 1 }} type="password" />
        <button onClick={connect} style={btn}>{live ? "reconnect" : "watch"}</button>
      </div>
      <div>
        {msgs.map((m) => (
          <div key={m.seq} style={{ padding: "6px 0", borderTop: "1px solid #ece9e3" }}>
            <span style={{ color: "#8a8576" }}>{m.author_id}</span>
            {m.depth > 0 && <span style={{ color: "#b8b2a3" }}> · d{m.depth}</span>}
            <div style={{ whiteSpace: "pre-wrap" }}>{m.body}</div>
          </div>
        ))}
        {!msgs.length && <div style={{ color: "#b8b2a3" }}>no messages yet</div>}
      </div>
    </main>
  );
}

const inp: React.CSSProperties = {
  border: "1px solid #ddd8cf",
  background: "#fff",
  padding: "6px 8px",
  borderRadius: 4,
  font: "inherit",
};
const btn: React.CSSProperties = {
  border: "1px solid #1a1a1a",
  background: "#1a1a1a",
  color: "#fff",
  padding: "6px 14px",
  borderRadius: 4,
  cursor: "pointer",
  font: "inherit",
};
