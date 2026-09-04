// Live fan-out helpers — the single place that decides WHICH SessionDO
// instance a broadcast goes to, and the only place that talks to it.
//
// ## Why there is exactly one instance
//
// Every call site used to derive the object id from
// `request.headers.get("x-session-id") || "default"`. A browser cannot set a
// header on a WebSocket upgrade (it is a plain GET issued by the WebSocket
// constructor), so a tab was permanently pinned to the `"default"` room while
// any client that DID send the header would publish into a room nobody was
// listening in — a silent failure with no error anywhere.
//
// Timon is a single-owner product: one person, one task list, several devices
// looking at it. Sharding it buys nothing and can only desynchronise the
// devices, so the header is gone and the name is a constant. The alternative
// considered — accepting `?session=` on the upgrade so the browser could
// participate — keeps a knob that has no product meaning and lets a typo in a
// URL quietly cut a tab off from every update.
//
// ## Why a failed broadcast never fails the request
//
// Each publish runs after its D1 write has already committed. Turning a
// relay hiccup into a 500 would make apollo retry a `POST /api/tasks` that
// actually succeeded and duplicate the task. The mutation is reported as it
// happened; the tab that missed the event resyncs on its next reconnect.
// Failures are logged, never swallowed, and never retried in-Worker.

import { getTaskRow } from "./store.js";

export const SESSION_DO_NAME = "default";

export function sessionStub(env) {
  return env.SESSION.get(env.SESSION.idFromName(SESSION_DO_NAME));
}

async function publish(env, label, send) {
  try {
    await send(sessionStub(env));
  } catch (err) {
    console.error(`live: ${label} broadcast failed`, err);
  }
}

/** `task` must be a full `getTaskRow` row, not the intent wrapper. */
export function publishTaskAdded(env, task) {
  return publish(env, "task_added", (stub) => stub.addTask(task));
}

export function publishTaskUpdated(env, task) {
  return publish(env, "task_updated", (stub) => stub.updateTask(task));
}

export function publishTaskDeleted(env, taskId) {
  return publish(env, "task_deleted", (stub) => stub.removeTask(taskId));
}

/**
 * Re-read and announce tasks whose ROW changed as a side effect of someone
 * else's mutation — a new parent's `subtask_count`, a dependent's
 * `blocked_by`. Ids that no longer resolve are skipped rather than announced
 * as an update to nothing.
 */
export async function publishTaskUpdatedByIds(env, db, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  for (const id of unique) {
    let row;
    try {
      row = await getTaskRow(db, id);
    } catch (err) {
      console.error("live: could not re-read related task", id, err);
      continue;
    }
    if (row) await publishTaskUpdated(env, row);
  }
}
