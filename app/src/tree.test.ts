import { describe, it, expect } from "vitest";
import { buildTree } from "./tree";
import type { Task } from "./format";

function task(id: string, parent_id: string | null = null): Task {
  return {
    id,
    title: id,
    parent_id,
    due_date: null,
    priority: "medium",
    category: null,
    status: "pending",
    completed_at: null,
    created_at: "2026-08-29T00:00:00Z",
    updated_at: "2026-08-29T00:00:00Z",
  };
}

describe("buildTree", () => {
  it("nests a subtask under its parent", () => {
    const roots = buildTree([task("p"), task("c", "p")]);
    expect(roots.map((n) => n.task.id)).toEqual(["p"]);
    expect(roots[0].children.map((n) => n.task.id)).toEqual(["c"]);
  });

  it("promotes an orphan whose parent is filtered out", () => {
    const roots = buildTree([task("c", "missing-parent")]);
    expect(roots.map((n) => n.task.id)).toEqual(["c"]);
  });

  it("keeps every task exactly once", () => {
    const input = [task("a"), task("b", "a"), task("c", "b"), task("d")];
    const seen: string[] = [];
    const walk = (nodes: ReturnType<typeof buildTree>): void => {
      for (const node of nodes) {
        seen.push(node.task.id);
        walk(node.children);
      }
    };
    walk(buildTree(input));
    expect(seen.sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("does not loop forever on a cyclic parent chain", () => {
    const roots = buildTree([task("a", "b"), task("b", "a")]);
    const ids: string[] = [];
    const walk = (nodes: ReturnType<typeof buildTree>, depth: number): void => {
      expect(depth).toBeLessThan(5);
      for (const node of nodes) {
        ids.push(node.task.id);
        walk(node.children, depth + 1);
      }
    };
    walk(roots, 0);
    expect(ids.sort()).toEqual(["a", "b"]);
  });

  it("ignores a task that claims itself as parent", () => {
    const roots = buildTree([task("a", "a")]);
    expect(roots.map((n) => n.task.id)).toEqual(["a"]);
    expect(roots[0].children).toEqual([]);
  });
});
