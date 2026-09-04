// Live broadcast contract (NID-529).
//
// The one thing these tests exist to protect: what an open tab receives over
// the socket has to be the SAME shape it would have fetched from
// `GET /api/tasks`. When the broadcast carried the intent wrapper instead, a
// live card rendered with no due date, no category and no blockers — and
// nothing failed, so nothing caught it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockD1 } from "./mock-d1.js";
import { createMockSession } from "./mock-session.js";
import { ensureSchema, createTask, addDependency } from "../src/lib/store.js";

function makeEnv() {
  return {
    TIMON_API_KEY: "test-api-key-123",
    TIMON_META: createMockD1(),
    SESSION: createMockSession(),
    ASSETS: { fetch: vi.fn(async () => new Response("ok", { status: 200 })) },
  };
}

function authHeaders(env) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${env.TIMON_API_KEY}`,
  };
}

function url(path) {
  return `https://timon-worker.example.com${path}`;
}

async function listRow(worker, env, taskId) {
  const response = await worker.fetch(
    new Request(url("/api/tasks"), { headers: authHeaders(env) }),
    env
  );
  const { tasks } = await response.json();
  return tasks.find((task) => task.id === taskId);
}

let worker;

beforeEach(async () => {
  vi.resetModules();
  // Two upstreams behind one stub: Whisper for `/api/voice`, and the chat
  // completion `extractIntent` calls on both write paths.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target) => {
      if (String(target).includes("/audio/transcriptions")) {
        return new Response(
          JSON.stringify({ text: "comprar leche", duration: 1.2 }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
        { status: 200 }
      );
    })
  );
  worker = (await import("../src/index.js")).default;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("task_added payload", () => {
  it("matches the GET /api/tasks row shape exactly", async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);

    const response = await worker.fetch(
      new Request(url("/api/tasks"), {
        method: "POST",
        headers: authHeaders(env),
        body: JSON.stringify({ text: "comprar leche" }),
      }),
      env
    );
    expect(response.status).toBe(201);
    const { task_id: taskId } = await response.json();

    const [event] = env.SESSION._events;
    expect(event.type).toBe("task_added");
    expect(event.task).toEqual(await listRow(worker, env, taskId));
  });

  it("carries the decoration a list card renders, not just the bare row", async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    const parentId = await createTask(env.TIMON_META, { title: "Mudanza" });

    await worker.fetch(
      new Request(url("/api/tasks"), {
        method: "POST",
        headers: authHeaders(env),
        body: JSON.stringify({ text: "embalar libros", parent_id: parentId }),
      }),
      env
    );

    const added = env.SESSION._events.find((e) => e.type === "task_added");
    expect(added.task).toMatchObject({
      parent_id: parentId,
      parent_title: "Mudanza",
      subtask_count: 0,
      blocked_by: [],
      blocked_by_count: 0,
      blocked_by_open_count: 0,
    });
  });

  it("also announces the parent, whose subtask count just changed", async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    const parentId = await createTask(env.TIMON_META, { title: "Mudanza" });

    await worker.fetch(
      new Request(url("/api/tasks"), {
        method: "POST",
        headers: authHeaders(env),
        body: JSON.stringify({ text: "embalar libros", parent_id: parentId }),
      }),
      env
    );

    const parentEvent = env.SESSION._events.find(
      (e) => e.type === "task_updated" && e.task.id === parentId
    );
    expect(parentEvent.task.subtask_count).toBe(1);
  });
});

describe("the ESP32 voice path", () => {
  it("broadcasts the full row, not the intent wrapper", async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);

    const response = await worker.fetch(
      new Request(url("/api/voice"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.TIMON_API_KEY}`,
          "content-type": "application/octet-stream",
          "x-device-id": "esp32-1",
        },
        body: new Uint8Array([1, 2, 3]),
      }),
      env
    );
    expect(response.status).toBe(200);

    const { task_id: taskId } = await response.json();
    const [event] = env.SESSION._events;
    expect(event.type).toBe("task_added");
    // This is the path the acceptance demo runs. It used to broadcast
    // `{ taskId, intent, addedAt }`, which rendered a card with no due date,
    // no category and no blockers.
    expect(event.task).toEqual(await listRow(worker, env, taskId));
    expect(event.task.title).toBe("comprar leche");
  });
});

describe("the /api/ws gate", () => {
  function upgrade(headers) {
    return new Request(url("/api/ws"), { headers: { upgrade: "websocket", ...headers } });
  }

  it("refuses an anonymous upgrade", async () => {
    const response = await worker.fetch(upgrade({}), makeEnv());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("refuses a foreign Origin even with a valid credential", async () => {
    // A WebSocket handshake is not subject to CORS, so without this check a
    // page on any origin could open a socket in a logged-in owner's browser
    // and read every task that gets broadcast.
    const env = makeEnv();
    const response = await worker.fetch(
      upgrade({
        authorization: `Bearer ${env.TIMON_API_KEY}`,
        origin: "https://evil.example",
      }),
      env
    );
    expect(response.status).toBe(403);
    expect(env.SESSION.get).not.toHaveBeenCalled();
  });

  it("lets the app's own origins through", async () => {
    for (const origin of [
      "https://timon-worker.example.com",
      "https://timon.ygdcbtmc4u.uk",
      "https://timon-worker.ygdcbtmc4u.workers.dev",
    ]) {
      const env = makeEnv();
      const response = await worker.fetch(
        upgrade({ authorization: `Bearer ${env.TIMON_API_KEY}`, origin }),
        env
      );
      expect(response.status).not.toBe(403);
      expect(env.SESSION._stub.fetch).toHaveBeenCalled();
    }
  });

  it("lets a header-less client through — the ESP32 sends no Origin", async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      upgrade({ authorization: `Bearer ${env.TIMON_API_KEY}` }),
      env
    );
    expect(response.status).not.toBe(403);
    expect(env.SESSION._stub.fetch).toHaveBeenCalled();
  });
});

describe("Durable Object sharding", () => {
  it("always resolves the same instance, whatever x-session-id says", async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);

    await worker.fetch(
      new Request(url("/api/tasks"), {
        method: "POST",
        headers: { ...authHeaders(env), "x-session-id": "phone" },
        body: JSON.stringify({ text: "una" }),
      }),
      env
    );
    await worker.fetch(
      new Request(url("/api/ws"), {
        headers: {
          authorization: `Bearer ${env.TIMON_API_KEY}`,
          upgrade: "websocket",
        },
      }),
      env
    );

    // A browser cannot set a header on a WebSocket upgrade. If the header still
    // shaped the id, the tab would sit in "default" while a header-sending
    // client published into another room — no error, just silence.
    expect(env.SESSION._names.length).toBeGreaterThan(1);
    expect(new Set(env.SESSION._names)).toEqual(new Set(["default"]));
  });
});

describe("edit, complete and delete go live", () => {
  it("PATCH broadcasts task_updated with the full row", async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    const taskId = await createTask(env.TIMON_META, { title: "Llamar al banco" });

    const response = await worker.fetch(
      new Request(url(`/api/tasks/${taskId}`), {
        method: "PATCH",
        headers: authHeaders(env),
        body: JSON.stringify({ status: "done" }),
      }),
      env
    );
    expect(response.status).toBe(200);

    const [event] = env.SESSION._events;
    expect(event.type).toBe("task_updated");
    expect(event.task).toEqual(await listRow(worker, env, taskId));
    expect(event.task.status).toBe("done");
  });

  it("re-parenting announces both the old and the new parent", async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    const oldParent = await createTask(env.TIMON_META, { title: "Vieja" });
    const newParent = await createTask(env.TIMON_META, { title: "Nueva" });
    const child = await createTask(env.TIMON_META, {
      title: "Hija",
      parent_id: oldParent,
    });

    await worker.fetch(
      new Request(url(`/api/tasks/${child}`), {
        method: "PATCH",
        headers: authHeaders(env),
        body: JSON.stringify({ parent_id: newParent }),
      }),
      env
    );

    const announced = env.SESSION._events
      .filter((e) => e.type === "task_updated")
      .map((e) => e.task.id);
    expect(announced).toContain(oldParent);
    expect(announced).toContain(newParent);
  });

  it("DELETE broadcasts task_deleted and refreshes the orphaned children", async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    const parent = await createTask(env.TIMON_META, { title: "Padre" });
    const child = await createTask(env.TIMON_META, {
      title: "Hija",
      parent_id: parent,
    });

    const response = await worker.fetch(
      new Request(url(`/api/tasks/${parent}`), {
        method: "DELETE",
        headers: authHeaders(env),
      }),
      env
    );
    expect(response.status).toBe(200);

    expect(env.SESSION._events).toContainEqual({
      type: "task_deleted",
      task_id: parent,
    });
    const childEvent = env.SESSION._events.find(
      (e) => e.type === "task_updated" && e.task.id === child
    );
    expect(childEvent.task.parent_id).toBeNull();
  });
});

describe("relationship edits go live", () => {
  it("adding a dependency announces both ends", async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    const a = await createTask(env.TIMON_META, { title: "A" });
    const b = await createTask(env.TIMON_META, { title: "B" });

    await worker.fetch(
      new Request(url(`/api/tasks/${a}/dependencies`), {
        method: "POST",
        headers: authHeaders(env),
        body: JSON.stringify({ depends_on_id: b }),
      }),
      env
    );

    const ids = env.SESSION._events.map((e) => e.task.id);
    expect(ids).toEqual([a, b]);
    const blocked = env.SESSION._events.find((e) => e.task.id === a);
    expect(blocked.task.blocked_by).toEqual([
      { id: b, title: "B", status: "pending" },
    ]);
  });

  it("removing a dependency announces both ends", async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    const a = await createTask(env.TIMON_META, { title: "A" });
    const b = await createTask(env.TIMON_META, { title: "B" });
    await addDependency(env.TIMON_META, a, b);

    await worker.fetch(
      new Request(url(`/api/tasks/${a}/dependencies/${b}`), {
        method: "DELETE",
        headers: authHeaders(env),
      }),
      env
    );

    expect(env.SESSION._events.map((e) => e.task.id)).toEqual([a, b]);
    expect(env.SESSION._events[0].task.blocked_by).toEqual([]);
  });

  it("stays quiet when the DELETE removed nothing", async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    const a = await createTask(env.TIMON_META, { title: "A" });
    const b = await createTask(env.TIMON_META, { title: "B" });

    const response = await worker.fetch(
      new Request(url(`/api/tasks/${a}/dependencies/${b}`), {
        method: "DELETE",
        headers: authHeaders(env),
      }),
      env
    );

    expect(await response.json()).toEqual({ removed: false });
    expect(env.SESSION._events).toHaveLength(0);
  });
});

describe("a broken relay never breaks a committed mutation", () => {
  it("still returns 201 when the broadcast throws", async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    env.SESSION._stub.addTask.mockRejectedValueOnce(new Error("DO unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await worker.fetch(
      new Request(url("/api/tasks"), {
        method: "POST",
        headers: authHeaders(env),
        body: JSON.stringify({ text: "comprar leche" }),
      }),
      env
    );

    // apollo retries a failed POST. Turning a relay hiccup into a 500 would
    // duplicate a task that was already written to D1.
    expect(response.status).toBe(201);
    expect(console.error).toHaveBeenCalled();
  });
});
