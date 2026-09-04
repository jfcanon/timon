import { describe, it, expect } from "vitest";
import { SessionDO } from "../src/durable-objects/session.js";

function makeCtx() {
  const store = new Map();
  const sockets = [];
  return {
    storage: {
      get: async (key) => store.get(key),
      put: async (key, value) => {
        store.set(key, value);
      },
    },
    blockConcurrencyWhile: async (fn) => fn(),
    acceptWebSocket: (ws) => sockets.push(ws),
    getWebSockets: () => sockets,
    sockets,
  };
}

function row(overrides = {}) {
  return {
    id: "task-1",
    title: "buy milk",
    parent_id: null,
    due_date: null,
    priority: "medium",
    category: null,
    status: "pending",
    completed_at: null,
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z",
    parent_title: null,
    subtask_count: 0,
    blocked_by: [],
    blocked_by_count: 0,
    blocked_by_open_count: 0,
    ...overrides,
  };
}

describe("SessionDO broadcasts", () => {
  it("addTask broadcasts the full task row as task_added", async () => {
    const ctx = makeCtx();
    const sent = [];
    ctx.sockets.push({ send: (message) => sent.push(JSON.parse(message)) });
    const session = new SessionDO(ctx, {});
    await Promise.resolve();
    const task = row();
    await session.addTask(task);
    expect(sent).toEqual([{ type: "task_added", task }]);
  });

  it("updateTask broadcasts the full task row as task_updated", async () => {
    const ctx = makeCtx();
    const sent = [];
    ctx.sockets.push({ send: (message) => sent.push(JSON.parse(message)) });
    const session = new SessionDO(ctx, {});
    await Promise.resolve();
    const task = row({ status: "done" });
    await session.updateTask(task);
    expect(sent).toEqual([{ type: "task_updated", task }]);
  });

  it("removeTask broadcasts the full task row as task_deleted", async () => {
    const ctx = makeCtx();
    const sent = [];
    ctx.sockets.push({ send: (message) => sent.push(JSON.parse(message)) });
    const session = new SessionDO(ctx, {});
    await Promise.resolve();
    const task = row();
    await session.removeTask(task);
    expect(sent).toEqual([{ type: "task_deleted", task }]);
  });
});
