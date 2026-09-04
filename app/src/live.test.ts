// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import type { Task } from "./format";
import {
  applyLiveTasks,
  liveUrl,
  matchesFilters,
  prefersReducedMotion,
  reconnectDelay,
} from "./live";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t-1",
    title: "buy milk",
    parent_id: null,
    due_date: null,
    priority: "medium",
    category: "casa",
    status: "pending",
    completed_at: null,
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("liveUrl", () => {
  it("builds the WS URL from the current page origin", () => {
    expect(
      liveUrl({ protocol: "https:", host: "timon.ygdcbtmc4u.uk" })
    ).toBe("wss://timon.ygdcbtmc4u.uk/api/ws");
    expect(
      liveUrl({ protocol: "http:", host: "localhost:8787" })
    ).toBe("ws://localhost:8787/api/ws");
  });
});

describe("reconnectDelay", () => {
  it("backs off exponentially and caps at 15s", () => {
    expect(reconnectDelay(0)).toBe(1000);
    expect(reconnectDelay(1)).toBe(2000);
    expect(reconnectDelay(2)).toBe(4000);
    expect(reconnectDelay(10)).toBe(15000);
  });
});

describe("prefersReducedMotion", () => {
  it("skips the enter animation when the user asked for none", () => {
    expect(prefersReducedMotion({ matches: true })).toBe(true);
    expect(prefersReducedMotion({ matches: false })).toBe(false);
  });
});

describe("applyLiveTasks", () => {
  it("inserts a matching task_added at the front", () => {
    const existing = task({ id: "t-0", title: "older" });
    const incoming = task({ id: "t-new", title: "from voice" });
    const next = applyLiveTasks([existing], {}, {
      type: "task_added",
      task: incoming,
    });
    expect(next.enteredId).toBe("t-new");
    expect(next.tasks.map((t) => t.id)).toEqual(["t-new", "t-0"]);
  });

  it("ignores a task_added that does not match the active filters", () => {
    const existing = task();
    const incoming = task({ id: "t-2", status: "done" });
    const next = applyLiveTasks([existing], { status: "pending" }, {
      type: "task_added",
      task: incoming,
    });
    expect(next.enteredId).toBeNull();
    expect(next.tasks).toEqual([existing]);
  });

  it("updates in place without an enter animation", () => {
    const existing = task({ title: "old" });
    const incoming = task({ title: "new title", status: "in_progress" });
    const next = applyLiveTasks([existing], {}, {
      type: "task_updated",
      task: incoming,
    });
    expect(next.enteredId).toBeNull();
    expect(next.tasks[0].title).toBe("new title");
  });

  it("removes a deleted task", () => {
    const next = applyLiveTasks([task()], {}, {
      type: "task_deleted",
      task: task(),
    });
    expect(next.tasks).toEqual([]);
  });
});

describe("matchesFilters", () => {
  it("requires both status and category when set", () => {
    expect(matchesFilters(task(), { status: "pending" })).toBe(true);
    expect(matchesFilters(task(), { status: "done" })).toBe(false);
    expect(matchesFilters(task(), { category: "casa" })).toBe(true);
    expect(matchesFilters(task(), { category: "work" })).toBe(false);
  });
});
