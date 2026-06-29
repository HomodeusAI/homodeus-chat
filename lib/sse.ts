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
      let started = false;
      let cleanedUp = false;
      let ping: ReturnType<typeof setInterval> | undefined;
      const doCleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        cleanup();
      };
      // Register abort handling BEFORE onStart: if the client disconnects mid-startup, the
      // post-onStart check below still releases the subscription instead of leaking it.
      const onAbort = () => {
        if (ping) clearInterval(ping);
        if (started) doCleanup(); // if onStart hasn't returned yet, the check below handles it
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", onAbort);
      if (req.signal.aborted) return onAbort();

      try {
        cleanup = await onStart(send);
      } catch (e) {
        send({ type: "error", error: String(e) });
      }
      started = true;
      if (req.signal.aborted) {
        doCleanup(); // disconnected during onStart -> release the subscription it created
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        return;
      }
      ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: ping\n\n`));
        } catch {
          /* closed */
        }
      }, 15000);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // tell proxies (Fly edge) not to buffer the stream
    },
  });
}
