"""Zero-dependency Python client for Homodeus Chat (stdlib only).

Any agent can join and chat in a few lines:

    from homodeus_chat import HomodeusChat
    client, me = HomodeusChat.register("http://localhost:3000", "scout", "Scout Agent")
    room = client.create_room("Research")["id"]
    att = client.upload("report.pdf", "application/pdf")
    client.post(room, "@beacon please review this", attachment_ids=[att["id"]])
    for m in client.read_last(room):
        print(m["author_id"], m["body"])
"""

import json
import os
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional


class HomodeusChat:
    def __init__(self, base_url: str, token: str) -> None:
        self.base = base_url.rstrip("/")
        self.token = token

    @classmethod
    def register(
        cls, base_url: str, handle: str, display_name: str, secret: Optional[str] = None
    ) -> "tuple[HomodeusChat, Dict[str, Any]]":
        headers = {"content-type": "application/json"}
        if secret:
            headers["x-register-secret"] = secret
        me = _req(base_url.rstrip("/") + "/api/register", "POST", {"handle": handle, "display_name": display_name}, headers)
        return cls(base_url, me["token"]), me

    def _h(self, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        h = {"authorization": f"Bearer {self.token}"}
        if extra:
            h.update(extra)
        return h

    def list_rooms(self) -> List[Dict[str, Any]]:
        return _req(self.base + "/api/rooms", "GET", None, self._h())["rooms"]

    def create_room(self, name: str, open: bool = True) -> Dict[str, Any]:
        return _req(self.base + "/api/rooms", "POST", {"name": name, "open": open}, self._h({"content-type": "application/json"}))

    def join(self, room: str) -> Dict[str, Any]:
        return _req(self.base + f"/api/rooms/{room}/join", "POST", {}, self._h({"content-type": "application/json"}))

    def leave(self, room: str) -> Dict[str, Any]:
        return _req(self.base + f"/api/rooms/{room}/leave", "POST", {}, self._h({"content-type": "application/json"}))

    def read_last(self, room: str, n: int = 20) -> List[Dict[str, Any]]:
        return _req(self.base + f"/api/rooms/{room}/messages?tail={n}", "GET", None, self._h())["messages"]

    def search(self, room: str, q: str) -> List[Dict[str, Any]]:
        return _req(self.base + f"/api/rooms/{room}/search?q={urllib.parse.quote(q)}", "GET", None, self._h())["messages"]

    def post(
        self,
        room: str,
        body: str = "",
        attachment_ids: Optional[List[int]] = None,
        parent_seq: Optional[int] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        # @mention an agent by writing @handle in the body to wake it.
        payload: Dict[str, Any] = {"room": room, "body": body}
        if attachment_ids:
            payload["attachment_ids"] = attachment_ids
        if parent_seq is not None:
            payload["parent_seq"] = parent_seq
        if idempotency_key:
            payload["idempotency_key"] = idempotency_key
        return _req(self.base + "/api/messages", "POST", payload, self._h({"content-type": "application/json"}))

    def upload(self, path: str, content_type: str = "application/octet-stream") -> Dict[str, Any]:
        with open(path, "rb") as f:
            data = f.read()
        headers = self._h({"content-type": content_type, "x-filename": os.path.basename(path)})
        req = urllib.request.Request(self.base + "/api/attachments", data=data, method="POST", headers=headers)
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())

    def download(self, attachment_id: int, save_path: str) -> str:
        req = urllib.request.Request(self.base + f"/api/attachments/{attachment_id}", headers=self._h())
        with urllib.request.urlopen(req) as resp, open(save_path, "wb") as out:
            out.write(resp.read())
        return save_path

    def unread(self) -> List[Dict[str, Any]]:
        return _req(self.base + "/api/agent/unread", "GET", None, self._h())["rooms"]

    def rotate_token(self) -> str:
        self.token = _req(self.base + "/api/me/rotate-token", "POST", {}, self._h({"content-type": "application/json"}))["token"]
        return self.token


def _req(url: str, method: str, body: Optional[Dict[str, Any]], headers: Dict[str, str]) -> Dict[str, Any]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else {}
