// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { backoffDelay, connectLive, liveUrl, type LiveEvent } from "./live";

describe("liveUrl", () => {
  it("upgrades https to wss on the SAME host the page is on", () => {
    // `__Host-timon_session` is host-locked: a session minted on the custom
    // domain is not sent to workers.dev. Hard-coding either host would hand
    // the upgrade no cookie on the other one.
    expect(liveUrl({ protocol: "https:", host: "timon.ygdcbtmc4u.uk" })).toBe(
      "wss://timon.ygdcbtmc4u.uk/api/ws"
    );
    expect(
      liveUrl({ protocol: "https:", host: "timon-worker.ygdcbtmc4u.workers.dev" })
    ).toBe("wss://timon-worker.ygdcbtmc4u.workers.dev/api/ws");
  });

  it("falls back to ws on a plain-http dev origin", () => {
    expect(liveUrl({ protocol: "http:", host: "localhost:8787" })).toBe(
      "ws://localhost:8787/api/ws"
    );
  });
});

describe("backoffDelay", () => {
  it("grows with each attempt and never drops below the base delay", () => {
    const ceilings = [0, 1, 2, 3].map((n) => backoffDelay(n, () => 1));
    expect(ceilings).toEqual([1000, 2000, 4000, 8000]);
    for (const attempt of [0, 1, 5, 20]) {
      expect(backoffDelay(attempt, () => 0)).toBe(1000);
    }
  });

  it("caps so a long outage still retries twice a minute", () => {
    expect(backoffDelay(50, () => 1)).toBe(30_000);
  });

  it("jitters between the base and the ceiling", () => {
    expect(backoffDelay(4, () => 0.5)).toBe(8500);
  });
});

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;

  readyState = 0;
  sent: string[] = [];
  close = vi.fn();
  private listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  emit(type: string, event: unknown = {}): void {
    if (type === "open") this.readyState = 1;
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

function install(): void {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("connectLive", () => {
  it("reports live on open and hands parsed events to the view", () => {
    install();
    const onEvent = vi.fn();
    const onStatus = vi.fn();
    connectLive({ onEvent, onStatus, onResync: vi.fn() });

    const socket = FakeSocket.instances[0];
    expect(socket.url).toContain("/api/ws");
    expect(onStatus).toHaveBeenLastCalledWith("reconnecting");

    socket.emit("open");
    expect(onStatus).toHaveBeenLastCalledWith("live");

    const task = { id: "t1", title: "comprar leche" };
    socket.emit("message", { data: JSON.stringify({ type: "task_added", task }) });
    expect(onEvent).toHaveBeenCalledWith({ type: "task_added", task });
  });

  it("swallows keepalive traffic instead of re-rendering on it", () => {
    install();
    const onEvent = vi.fn();
    connectLive({ onEvent, onStatus: vi.fn(), onResync: vi.fn() });
    const socket = FakeSocket.instances[0];
    socket.emit("open");

    socket.emit("message", { data: JSON.stringify({ type: "pong" }) });
    socket.emit("message", { data: "{ not json" });

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("reconnects with backoff and asks for a resync once the gap is real", () => {
    vi.useFakeTimers();
    install();
    const onStatus = vi.fn();
    const onResync = vi.fn();
    connectLive({ onEvent: vi.fn(), onStatus, onResync });

    FakeSocket.instances[0].emit("open");
    FakeSocket.instances[0].emit("close");

    expect(onStatus).toHaveBeenLastCalledWith("reconnecting");
    // First failure is treated as a blip; nothing is asked of the view yet.
    expect(onResync).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(2);

    FakeSocket.instances[1].emit("close");
    // Two failures in a row is a real gap: the view refetches, which is also
    // what surfaces a dead session as a 401.
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it("resyncs on every reconnect, because the relay buffers nothing", () => {
    vi.useFakeTimers();
    install();
    const onResync = vi.fn();
    connectLive({ onEvent: vi.fn(), onStatus: vi.fn(), onResync });

    FakeSocket.instances[0].emit("open");
    expect(onResync).not.toHaveBeenCalled(); // first connect has nothing to catch up on

    FakeSocket.instances[0].emit("close");
    vi.advanceTimersByTime(60_000);
    FakeSocket.instances[1].emit("open");

    expect(onResync).toHaveBeenCalled();
  });

  it("stops retrying once closed by the shell", () => {
    vi.useFakeTimers();
    install();
    const handle = connectLive({
      onEvent: vi.fn(),
      onStatus: vi.fn(),
      onResync: vi.fn(),
    });

    FakeSocket.instances[0].emit("open");
    handle.close();
    FakeSocket.instances[0].emit("close");
    vi.advanceTimersByTime(120_000);

    // Logging out must not leave a socket backing off against a 401 forever.
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("pings so an idle connection is not culled by an intermediary", () => {
    vi.useFakeTimers();
    install();
    connectLive({ onEvent: vi.fn(), onStatus: vi.fn(), onResync: vi.fn() });

    FakeSocket.instances[0].emit("open");
    vi.advanceTimersByTime(26_000);

    expect(FakeSocket.instances[0].sent).toEqual([
      JSON.stringify({ type: "ping" }),
    ]);
  });
});

describe("event typing", () => {
  it("keeps task_deleted addressable by id alone", () => {
    const event: LiveEvent = { type: "task_deleted", task_id: "t1" };
    expect(event.task).toBeUndefined();
  });
});
