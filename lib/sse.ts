type Send = (data: unknown) => void;

// Build a Server-Sent-Events Response. onStart receives a `send` fn and returns a cleanup fn
// (run on client disconnect). A heartbeat keeps proxies from closing the idle connection.
export function sseResponse(
  req: Request,
  onStart: (send: Send) => (() => void) | Promise<() => void>,
): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send: Send = (d) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(d)}\n\n`));
        } catch {
          /* client gone; the async wake callback can fire after disconnect closed the stream */
        }
      };
      let cleanup: () => void = () => {};
      try {
        cleanup = await onStart(send);
      } catch (e) {
        send({ type: "error", error: String(e) });
      }
      const ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: ping\n\n`));
        } catch {
          /* closed */
        }
      }, 15000);
      req.signal.addEventListener("abort", () => {
        clearInterval(ping);
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
