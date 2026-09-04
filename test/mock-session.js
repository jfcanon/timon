import { vi } from "vitest";

/**
 * A stand-in for the SESSION Durable Object namespace that records every
 * broadcast the Worker asks for, so a test can assert on the live payload the
 * open tabs would actually receive.
 */
export function createMockSession() {
  const events = [];
  const names = [];

  const stub = {
    addTask: vi.fn(async (task) => {
      events.push({ type: "task_added", task });
    }),
    updateTask: vi.fn(async (task) => {
      events.push({ type: "task_updated", task });
    }),
    removeTask: vi.fn(async (taskId) => {
      events.push({ type: "task_deleted", task_id: taskId });
    }),
    // The real object answers 101 with a `webSocket` — a status Node's
    // `Response` refuses to construct, so the stand-in reports success as 200.
    fetch: vi.fn(async () => new Response(null, { status: 200 })),
  };

  return {
    idFromName: vi.fn((name) => {
      names.push(name);
      return `do-id:${name}`;
    }),
    get: vi.fn(() => stub),
    /** Every event broadcast so far, in order. */
    _events: events,
    /** Every name the Worker derived a DO id from. */
    _names: names,
    _stub: stub,
  };
}
