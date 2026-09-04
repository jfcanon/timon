import { DurableObject } from "cloudflare:workers";

/**
 * SessionDO — the live fan-out relay for the open browser tabs.
 *
 * D1 is the source of truth for tasks; this object holds no task state of its
 * own. It exists for one reason: a mutation that lands on the Worker (from the
 * ESP32/apollo voice path, or from another tab) has to reach every tab that is
 * already looking at the data, without a refresh.
 *
 * Two things about this file are load-bearing:
 *
 * 1. **Subscribers are read from `ctx.getWebSockets()`, never from an instance
 *    field.** `ctx.acceptWebSocket` opts into WebSocket hibernation: the
 *    runtime may evict this object while the sockets stay open, then construct
 *    a fresh instance to deliver the next event. Any `this.subscribers` array
 *    comes back empty after that eviction, so broadcasts would silently go
 *    nowhere — an open tab that sat idle for a few minutes would just stop
 *    updating. The hibernation-safe socket list is the one the runtime keeps.
 *
 * 2. **A socket is subscribed the moment it connects.** There is no
 *    `{"type":"subscribe"}` handshake to get right, which means no window in
 *    which a connected tab misses an event it should have seen.
 */
export class SessionDO extends DurableObject {
  /**
   * The Worker forwards the client's original request, so `url.pathname` here
   * is `/api/ws` — matching on a path is what previously made every upgrade
   * fall through to a 404. This object is only reachable through the Worker's
   * authorized `/api/ws` route, so the `Upgrade` header is the whole check.
   */
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    // The client's only job on this socket is to keep it alive. Anything else
    // is answered, never acted on — no task mutation is reachable from here.
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "invalid_json" }));
      return;
    }

    if (data.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    // Kept for the pre-NID-529 client, which announced itself before it
    // expected events. It is now already subscribed; just confirm.
    if (data.type === "subscribe") {
      ws.send(JSON.stringify({ type: "subscribed" }));
      return;
    }

    ws.send(JSON.stringify({ type: "error", error: "unknown_message" }));
  }

  async webSocketClose(ws, code, reason, wasClean) {
    ws.close(code === 1006 ? 1000 : code, reason);
  }

  /**
   * Fan a single event out to every connected tab. A socket that fails to
   * accept the write is closed rather than retried — Workers do not retry
   * (Talvi idiom), and the client reconnects with backoff on its own.
   */
  broadcast(event) {
    const message = JSON.stringify(event);
    let delivered = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
        delivered++;
      } catch (err) {
        console.error("SessionDO: dropping dead socket", err);
        try {
          ws.close(1011, "send failed");
        } catch {
          // Already gone; nothing left to clean up.
        }
      }
    }
    return delivered;
  }

  /**
   * `task` is the full `GET /api/tasks` row (see `getTaskRow` in store.js),
   * not the intent wrapper the pre-NID-529 version broadcast. The tab renders
   * the incoming card with the same code path it uses for a fetched one, so a
   * live card and a refreshed card are the same card.
   */
  async addTask(task) {
    return this.broadcast({ type: "task_added", task });
  }

  async updateTask(task) {
    return this.broadcast({ type: "task_updated", task });
  }

  async removeTask(taskId) {
    return this.broadcast({ type: "task_deleted", task_id: taskId });
  }
}
