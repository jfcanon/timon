// Live updates over the SessionDO WebSocket (NID-529).
//
// One socket for the whole app, owned by the shell. Views subscribe to it
// rather than opening their own, so navigating between the list and a task
// never drops and re-establishes a connection — and never opens two.
//
// ## Why the URL is derived from the current page
//
// The session cookie is `__Host-`-prefixed, which locks it to the exact host
// it was minted on: a session created on `timon.ygdcbtmc4u.uk` is simply not
// sent to `…workers.dev`. A hard-coded WebSocket host would therefore hand the
// upgrade no cookie and get a 401 — on whichever of the two hosts the owner
// did NOT log in to. Building from `location` means the socket always rides
// the cookie the page already has.
//
// The upgrade carries no `Authorization` header, and cannot: the WebSocket
// constructor issues a plain GET with no header hook. That is exactly why
// stage 2 shipped a cookie session — the two stages are one design.

import type { Task } from "./format";

export type LiveStatus = "live" | "reconnecting";

export interface LiveEvent {
  type: string;
  task?: Task;
  task_id?: string;
}

export interface LiveHandlers {
  /** A task was added, updated or deleted somewhere else. */
  onEvent: (event: LiveEvent) => void;
  onStatus: (status: LiveStatus) => void;
  /**
   * Re-read from the API. Fired after a gap in the stream (a reconnect, or a
   * connection we have failed to establish), because events that happened
   * while the socket was down were never queued anywhere — the DO is a relay,
   * not a log. It doubles as the session check: if the cookie died, the
   * refetch is what surfaces the 401 and sends the user to the login screen.
   */
  onResync: () => void;
}

export interface LiveHandle {
  close: () => void;
}

/**
 * What a view exposes to the shell so the one shared socket can drive it.
 * Views never open a socket themselves.
 */
export interface LiveSink {
  onEvent: (event: LiveEvent) => void;
  onResync: () => void;
}

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const PING_INTERVAL_MS = 25_000;
/** Failed attempts before we assume the gap is real and ask for a refetch. */
const RESYNC_AFTER_FAILURES = 2;

export function liveUrl(loc: { protocol: string; host: string }): string {
  const scheme = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${loc.host}/api/ws`;
}

/**
 * Exponential backoff with full jitter, capped. Jitter matters even with one
 * user: a phone waking several tabs at once would otherwise reconnect them in
 * lockstep, and every retry burst would hit the same second.
 */
export function backoffDelay(attempt: number, random = Math.random): number {
  const ceiling = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return Math.round(BASE_DELAY_MS + random() * (ceiling - BASE_DELAY_MS));
}

export function connectLive(handlers: LiveHandlers): LiveHandle {
  let socket: WebSocket | null = null;
  let retryTimer: number | undefined;
  let pingTimer: number | undefined;
  /** Consecutive failed or lost connections since the last successful open. */
  let failures = 0;
  let everConnected = false;
  let resyncRequested = false;
  let closed = false;

  const clearTimers = (): void => {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    if (pingTimer !== undefined) clearInterval(pingTimer);
    retryTimer = undefined;
    pingTimer = undefined;
  };

  const scheduleRetry = (): void => {
    if (closed || retryTimer !== undefined) return;
    // No point burning retries while the OS says there is no network; the
    // `online` listener below reconnects the moment there is.
    if (!navigator.onLine) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined;
      open();
    }, backoffDelay(Math.max(0, failures - 1)));
  };

  const dropped = (): void => {
    if (closed) return;
    clearTimers();
    socket = null;
    failures++;
    handlers.onStatus("reconnecting");
    if (!resyncRequested && failures >= RESYNC_AFTER_FAILURES) {
      resyncRequested = true;
      handlers.onResync();
    }
    scheduleRetry();
  };

  const open = (): void => {
    if (closed || socket) return;

    let ws: WebSocket;
    try {
      ws = new WebSocket(liveUrl(location));
    } catch {
      // A blocked or malformed URL throws synchronously; treat it as a drop so
      // the backoff still applies instead of leaving the app silently dead.
      dropped();
      return;
    }
    socket = ws;

    ws.addEventListener("open", () => {
      if (closed) {
        ws.close();
        return;
      }
      const missedEvents = everConnected;
      everConnected = true;
      failures = 0;
      resyncRequested = false;
      handlers.onStatus("live");
      // Anything that happened during the gap was never buffered for us.
      if (missedEvents) handlers.onResync();

      pingTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, PING_INTERVAL_MS);
    });

    ws.addEventListener("message", (event) => {
      let data: LiveEvent;
      try {
        data = JSON.parse(String(event.data)) as LiveEvent;
      } catch {
        return; // A frame we cannot parse is not worth tearing the socket down.
      }
      if (data.type === "pong" || data.type === "subscribed") return;
      handlers.onEvent(data);
    });

    // `error` is always followed by `close`, so recovery lives in one place.
    ws.addEventListener("close", () => {
      if (socket === ws) dropped();
    });
  };

  const reconnectNow = (): void => {
    if (closed || socket) return;
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    open();
  };

  const onOnline = (): void => reconnectNow();
  const onVisible = (): void => {
    // A backgrounded tab on iOS has its socket killed and its timers throttled;
    // waiting out a 30s backoff after the user has already looked at the screen
    // is the difference between "live" and "stale".
    if (document.visibilityState === "visible") reconnectNow();
  };

  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);

  handlers.onStatus("reconnecting");
  open();

  return {
    close(): void {
      closed = true;
      clearTimers();
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      const ws = socket;
      socket = null;
      ws?.close(1000, "client closed");
    },
  };
}
