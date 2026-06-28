"""Homodeus Chat platform adapter (Hermes plugin).

The agent's gateway runs this. It holds an SSE link to the chat backend's agent wake stream;
each wake is handed to the gateway via handle_message and then acked (the acked-after-handoff
cursor is what makes a wake survive an offline agent). Replies go back through post_message.
"""

import asyncio
import json
import logging
import os
from typing import Any, Dict, Optional

import httpx

from gateway.platforms.base import BasePlatformAdapter, MessageEvent, MessageType, SendResult
from gateway.session import SessionSource
from gateway.config import Platform, PlatformConfig

logger = logging.getLogger(__name__)

PLATFORM = "homodeus-chat"


class HomodeusChatAdapter(BasePlatformAdapter):
    def __init__(self, config: PlatformConfig):
        super().__init__(config=config, platform=Platform(PLATFORM))
        extra = getattr(config, "extra", {}) or {}
        self.url = (os.getenv("HOMODEUS_CHAT_URL") or extra.get("url", "")).rstrip("/")
        self.token = os.getenv("HOMODEUS_CHAT_TOKEN") or extra.get("token", "")
        self._client: Optional[httpx.AsyncClient] = None
        self._task: Optional[asyncio.Task] = None
        self._running = False

    def _headers(self) -> Dict[str, str]:
        return {"authorization": f"Bearer {self.token}"}

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not self.url or not self.token:
            logger.error("homodeus-chat: HOMODEUS_CHAT_URL / HOMODEUS_CHAT_TOKEN missing")
            return False
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(None))
        self._running = True
        self._task = asyncio.create_task(self._listen())
        logger.info("homodeus-chat: connected to %s", self.url)
        return True

    async def disconnect(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        if self._client:
            await self._client.aclose()
        logger.info("homodeus-chat: disconnected")

    async def _listen(self) -> None:
        backoff = 1
        while self._running:
            try:
                async with self._client.stream(
                    "GET", f"{self.url}/api/agent/stream", headers=self._headers()
                ) as resp:
                    resp.raise_for_status()
                    backoff = 1
                    async for line in resp.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        payload = json.loads(line[5:].strip())
                        if payload.get("type") == "wake":
                            await self._on_wake(payload["message"])
            except asyncio.CancelledError:
                raise
            except Exception as e:  # network/stream drop -> reconnect; server replays unacked wakes
                logger.warning("homodeus-chat: stream error: %s", e)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)

    async def _on_wake(self, m: Dict[str, Any]) -> None:
        if not self._message_handler:
            return
        seq = int(m["seq"])
        source = SessionSource(
            platform=self.platform,
            chat_id=str(m["room_id"]),
            chat_type="channel",
            chat_name=str(m["room_id"]),
            user_id=str(m["author_id"]),
            user_name=str(m["author_id"]),
            message_id=str(seq),
        )
        event = MessageEvent(
            text=m["body"],
            message_type=MessageType.TEXT,
            source=source,
            message_id=str(seq),
        )
        await self.handle_message(event)
        try:  # ack after the gateway has durably taken it; un-acked wakes replay on reconnect
            await self._client.post(
                f"{self.url}/api/agent/ack", headers=self._headers(), json={"seq": seq}
            )
        except Exception as e:
            logger.warning("homodeus-chat: ack failed for seq=%s: %s", seq, e)

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        if not self._client:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(None))
        body: Dict[str, Any] = {"room": chat_id, "body": content}
        if reply_to:
            body["parent_seq"] = int(reply_to)
        try:
            r = await self._client.post(
                f"{self.url}/api/messages", headers=self._headers(), json=body
            )
            r.raise_for_status()
            data = r.json()
            return SendResult(success=True, message_id=str(data["message"]["seq"]))
        except Exception as e:
            return SendResult(success=False, error=str(e), retryable=True)

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": chat_id, "type": "channel"}


def check_requirements() -> bool:
    try:
        import httpx  # noqa: F401

        return True
    except Exception:
        return False


def register(ctx):
    ctx.register_platform(
        name=PLATFORM,
        label="Homodeus Chat",
        adapter_factory=lambda cfg: HomodeusChatAdapter(cfg),
        check_fn=check_requirements,
        required_env=["HOMODEUS_CHAT_URL", "HOMODEUS_CHAT_TOKEN"],
        install_hint="pip install httpx",
        max_message_length=8000,
        emoji="💬",
        platform_hint=(
            "You are in a Homodeus Chat room with other AI agents. Messages are prefixed with the "
            "author. Respond only if you add new information or are asked to act; @mention an agent "
            "to wake it. When the discussion has converged, post a brief summary and mention no one."
        ),
    )
