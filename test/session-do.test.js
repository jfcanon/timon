// SessionDO — the relay itself (NID-529).
//
// Two regressions live here.
//
// 1. The Worker forwards the client's ORIGINAL request, so the path the object
//    sees is `/api/ws`. The previous version matched `url.pathname === "/ws"`,
//    which meant every real upgrade fell through to a 404 — the live feature
//    could not have worked at all.
// 2. Subscribers used to be tracked in an instance field. `acceptWebSocket`
//    opts into hibernation, so the runtime may evict the object and build a
//    fresh one to deliver the next event; that field comes back empty and the
//    broadcast reaches nobody. A tab that sat idle simply stopped updating,
//    with no error anywhere.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionDO } from "../src/durable-objects/session.js";

function fakeSocket() {
  return {
    sent: [],
    send(message) {
      this.sent.push(JSON.parse(message));
    },
    close: vi.fn(),
  };
}

/**
 * A stand-in for the DO context. `getWebSockets` reads the same array the
 * runtime would keep across a hibernation, which is the whole point.
 */
function fakeCtx(sockets = []) {
  return {
    acceptWebSocket: vi.fn((ws) => sockets.push(ws)),
    getWebSockets: () => sockets,
    storage: { get: vi.fn(async () => null), put: vi.fn(async () => {}) },
    blockConcurrencyWhile: vi.fn(async (fn) => fn()),
    _sockets: sockets,
  };
}

// Node refuses to construct a `Response` with status 101, so the upgrade tests
// swap in a minimal stand-in. What is under test is the routing decision and
// the status the object chooses, not Response's own validation.
class FakeResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.webSocket = init.webSocket ?? null;
  }
}

describe("the WebSocket upgrade", () => {
  beforeEach(() => {
    vi.stubGlobal("Response", FakeResponse);
    vi.stubGlobal(
      "WebSocketPair",
      class {
        constructor() {
          return { 0: fakeSocket(), 1: fakeSocket() };
        }
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts an upgrade on the /api/ws path the Worker actually forwards", async () => {
    const ctx = fakeCtx();
    const session = new SessionDO(ctx, {});

    const response = await session.fetch(
      new Request("https://timon-worker.example.com/api/ws", {
        headers: { upgrade: "websocket" },
      })
    );

    expect(response.status).toBe(101);
    expect(response.webSocket).toBeTruthy();
    expect(ctx.acceptWebSocket).toHaveBeenCalledOnce();
  });

  it("rejects a plain GET with 426", async () => {
    const ctx = fakeCtx();
    const session = new SessionDO(ctx, {});

    const response = await session.fetch(
      new Request("https://timon-worker.example.com/api/ws")
    );

    expect(response.status).toBe(426);
    expect(ctx.acceptWebSocket).not.toHaveBeenCalled();
  });
});

describe("broadcasting", () => {
  const row = { id: "t1", title: "comprar leche", status: "pending" };

  it("reaches a socket that never sent a subscribe message", () => {
    const socket = fakeSocket();
    const session = new SessionDO(fakeCtx([socket]), {});

    session.addTask(row);

    expect(socket.sent).toEqual([{ type: "task_added", task: row }]);
  });

  it("still reaches sockets after the object was rebuilt from hibernation", () => {
    const sockets = [fakeSocket(), fakeSocket()];
    const ctx = fakeCtx(sockets);

    // The connection happened on one instance...
    new SessionDO(ctx, {});
    // ...and the event is delivered on a fresh one. Anything held in an
    // instance field would be gone by now.
    const revived = new SessionDO(ctx, {});
    revived.updateTask(row);

    for (const socket of sockets) {
      expect(socket.sent).toEqual([{ type: "task_updated", task: row }]);
    }
  });

  it("sends a delete as an id, since the row no longer exists", () => {
    const socket = fakeSocket();
    const session = new SessionDO(fakeCtx([socket]), {});

    session.removeTask("t1");

    expect(socket.sent).toEqual([{ type: "task_deleted", task_id: "t1" }]);
  });

  it("drops a dead socket without starving the healthy ones", async () => {
    const dead = fakeSocket();
    dead.send = () => {
      throw new Error("socket closed");
    };
    const healthy = fakeSocket();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const session = new SessionDO(fakeCtx([dead, healthy]), {});
    const delivered = await session.addTask(row);

    expect(delivered).toBe(1);
    expect(healthy.sent).toHaveLength(1);
    expect(dead.close).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("incoming messages", () => {
  it("answers a keepalive ping", async () => {
    const socket = fakeSocket();
    const session = new SessionDO(fakeCtx([socket]), {});

    await session.webSocketMessage(socket, JSON.stringify({ type: "ping" }));

    expect(socket.sent).toEqual([{ type: "pong" }]);
  });

  it("confirms a subscribe from the pre-NID-529 client", async () => {
    const socket = fakeSocket();
    const session = new SessionDO(fakeCtx([socket]), {});

    await session.webSocketMessage(socket, JSON.stringify({ type: "subscribe" }));

    expect(socket.sent).toEqual([{ type: "subscribed" }]);
  });

  it("reports malformed input instead of throwing", async () => {
    const socket = fakeSocket();
    const session = new SessionDO(fakeCtx([socket]), {});

    await session.webSocketMessage(socket, "not json");

    expect(socket.sent).toEqual([{ type: "error", error: "invalid_json" }]);
  });
});
