// How a live broadcast changes the rows the list is showing.
//
// Pure and separate from the view so the interesting cases — an edit that
// pushes a task out of the active filter, a delete for a row we never had —
// are unit-testable without a DOM.

import type { ListFilters } from "./api";
import type { Task } from "./format";
import type { LiveEvent } from "./live";

/** The server orders by `created_at DESC`; a live insert has to agree. */
export function byNewestFirst(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function matchesFilters(task: Task, filters: ListFilters): boolean {
  if (filters.status && task.status !== filters.status) return false;
  if (filters.category && task.category !== filters.category) return false;
  return true;
}

/**
 * Apply one broadcast, returning a NEW array — the view renders from this, so
 * mutating in place would let what is on screen and what we think is on screen
 * drift apart.
 */
export function applyEvent(
  tasks: readonly Task[],
  event: LiveEvent,
  filters: ListFilters
): Task[] {
  if (event.type === "task_deleted") {
    return tasks.filter((task) => task.id !== event.task_id);
  }

  const incoming = event.task;
  if (!incoming) return [...tasks];

  const without = tasks.filter((task) => task.id !== incoming.id);
  // An edit can move a task out of the current filter — a task marked done
  // must leave a list filtered to "pendiente" rather than sit there lying.
  if (!matchesFilters(incoming, filters)) return without;
  return byNewestFirst([...without, incoming]);
}
