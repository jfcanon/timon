import { describe, it, expect } from "vitest";
import { applyEvent, byNewestFirst, matchesFilters } from "./list-state";
import type { Task } from "./format";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "comprar leche",
    parent_id: null,
    due_date: null,
    priority: "medium",
    category: null,
    status: "pending",
    completed_at: null,
    created_at: "2026-09-01T10:00:00.000Z",
    updated_at: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("matchesFilters", () => {
  it("keeps everything when no filter is active", () => {
    expect(matchesFilters(task(), {})).toBe(true);
  });

  it("matches on status and category independently", () => {
    expect(matchesFilters(task({ status: "done" }), { status: "done" })).toBe(true);
    expect(matchesFilters(task({ status: "done" }), { status: "pending" })).toBe(
      false
    );
    expect(
      matchesFilters(task({ category: "casa" }), { category: "trabajo" })
    ).toBe(false);
  });
});

describe("byNewestFirst", () => {
  it("orders newest first, the way GET /api/tasks does", () => {
    const older = task({ id: "old", created_at: "2026-09-01T10:00:00.000Z" });
    const newer = task({ id: "new", created_at: "2026-09-02T10:00:00.000Z" });
    expect(byNewestFirst([older, newer]).map((t) => t.id)).toEqual(["new", "old"]);
  });
});

describe("applyEvent", () => {
  const existing = task({ id: "t1", created_at: "2026-09-01T10:00:00.000Z" });

  it("puts a task spoken to the ESP32 at the top of the list", () => {
    const arriving = task({ id: "t2", created_at: "2026-09-03T10:00:00.000Z" });
    const next = applyEvent([existing], { type: "task_added", task: arriving }, {});
    expect(next.map((t) => t.id)).toEqual(["t2", "t1"]);
  });

  it("never mutates the array the view is rendering from", () => {
    const before = [existing];
    applyEvent(before, { type: "task_added", task: task({ id: "t2" }) }, {});
    expect(before).toEqual([existing]);
  });

  it("replaces rather than duplicates a task it already has", () => {
    const edited = { ...existing, title: "comprar leche descremada" };
    const next = applyEvent([existing], { type: "task_updated", task: edited }, {});
    expect(next).toHaveLength(1);
    expect(next[0].title).toBe("comprar leche descremada");
  });

  it("drops a task that the edit pushed out of the active filter", () => {
    // Completing a task in another tab must remove it from a list filtered to
    // "pendiente", not leave it sitting there claiming to be pending.
    const completed = { ...existing, status: "done" };
    const next = applyEvent(
      [existing],
      { type: "task_updated", task: completed },
      { status: "pending" }
    );
    expect(next).toEqual([]);
  });

  it("pulls in a task that the edit moved INTO the active filter", () => {
    const nowDone = task({ id: "t9", status: "done" });
    const next = applyEvent([], { type: "task_updated", task: nowDone }, {
      status: "done",
    });
    expect(next.map((t) => t.id)).toEqual(["t9"]);
  });

  it("removes a deleted task and shrugs at one it never had", () => {
    expect(
      applyEvent([existing], { type: "task_deleted", task_id: "t1" }, {})
    ).toEqual([]);
    expect(
      applyEvent([existing], { type: "task_deleted", task_id: "nope" }, {})
    ).toEqual([existing]);
  });

  it("ignores an event with no payload rather than blanking the list", () => {
    expect(applyEvent([existing], { type: "task_updated" }, {})).toEqual([
      existing,
    ]);
  });
});
