import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockD1 } from "./mock-d1.js";
import { ensureSchema } from "../src/lib/store.js";
import {
  createSessionToken,
  SESSION_COOKIE,
} from "../src/lib/auth.js";

function mockSession() {
  return {
    addTask: vi.fn(async (task) => task),
    updateTask: vi.fn(async (task) => task),
    removeTask: vi.fn(async (task) => task),
    fetch: vi.fn(async () => new Response("ok", { status: 200 })),
  };
}

function makeEnv(overrides = {}) {
  const session = mockSession();
  return {
    TIMON_API_KEY: "test-api-key-123",
    SESSION_SECRET: "test-session-secret-32-bytes-long!!",
    TIMON_META: createMockD1(),
    SESSION: {
      idFromName: vi.fn((name) => name),
      get: vi.fn(() => session),
    },
    ASSETS: {
      fetch: vi.fn(async () => new Response("ok", { status: 200 })),
    },
    ...overrides,
    _session: session,
  };
}

function authHeaders(env, extra = {}) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${env.TIMON_API_KEY}`,
    ...extra,
  };
}

describe("SessionDO live path (NID-529)", () => {
  let worker;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).includes("transcriptions")) {
          return new Response(JSON.stringify({ text: "comprar leche" }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
          { status: 200 }
        );
      })
    );
    const mod = await import("../src/index.js");
    worker = mod.default;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GET /api/ws is 401 anonymous", async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      new Request("https://timon.example/api/ws"),
      env
    );
    expect(response.status).toBe(401);
    expect(env.SESSION.get).not.toHaveBeenCalled();
  });

  it("GET /api/ws with a session cookie reaches SessionDO and is not 401", async () => {
    const env = makeEnv();
    const token = await createSessionToken(env, "owner");
    const response = await worker.fetch(
      new Request("https://timon.example/api/ws", {
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env
    );
    expect(response.status).not.toBe(401);
    expect(env.SESSION.idFromName).toHaveBeenCalledWith("default");
    expect(env._session.fetch).toHaveBeenCalled();
  });

  it("GET /api/ws with Bearer reaches SessionDO", async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      new Request("https://timon.example/api/ws", {
        headers: { authorization: `Bearer ${env.TIMON_API_KEY}` },
      }),
      env
    );
    expect(response.status).not.toBe(401);
    expect(env._session.fetch).toHaveBeenCalled();
  });

  it("pins the DO id to default even when x-session-id is set", async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    await worker.fetch(
      new Request("https://timon.example/api/tasks", {
        method: "POST",
        headers: authHeaders(env, { "x-session-id": "other-session" }),
        body: JSON.stringify({ text: "buy milk" }),
      }),
      env
    );
    await worker.fetch(
      new Request("https://timon.example/api/ws", {
        headers: {
          authorization: `Bearer ${env.TIMON_API_KEY}`,
          "x-session-id": "other-session",
        },
      }),
      env
    );
    const names = env.SESSION.idFromName.mock.calls.map((call) => call[0]);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((name) => name === "default")).toBe(true);
  });

  it("task_added payload matches the GET /api/tasks row shape", async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    const created = await worker.fetch(
      new Request("https://timon.example/api/tasks", {
        method: "POST",
        headers: authHeaders(env),
        body: JSON.stringify({ text: "buy milk" }),
      }),
      env
    );
    expect(created.status).toBe(201);
    expect(env._session.addTask).toHaveBeenCalledTimes(1);
    const broadcast = env._session.addTask.mock.calls[0][0];

    const listed = await worker.fetch(
      new Request("https://timon.example/api/tasks", {
        headers: authHeaders(env),
      }),
      env
    );
    expect(listed.status).toBe(200);
    const body = await listed.json();
    const row = body.tasks.find((task) => task.id === broadcast.id);
    expect(row).toBeDefined();
    expect(Object.keys(broadcast).sort()).toEqual(Object.keys(row).sort());
    expect(broadcast).toEqual(row);
    expect(broadcast.title).toBeDefined();
    expect(broadcast).not.toHaveProperty("intent");
    expect(broadcast).not.toHaveProperty("taskId");
  });

  it("POST /api/tasks with Bearer still 201 and still broadcasts", async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    const response = await worker.fetch(
      new Request("https://timon.example/api/tasks", {
        method: "POST",
        headers: authHeaders(env),
        body: JSON.stringify({ text: "buy milk" }),
      }),
      env
    );
    expect(response.status).toBe(201);
    expect(env._session.addTask).toHaveBeenCalledTimes(1);
  });

  it("handleVoice broadcasts the full D1 row", async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    const response = await worker.fetch(
      new Request("https://timon.example/api/voice", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.TIMON_API_KEY}`,
          "content-type": "audio/wav",
        },
        body: new ArrayBuffer(8),
      }),
      env
    );
    expect(response.status).toBe(200);
    expect(env._session.addTask).toHaveBeenCalledTimes(1);
    const broadcast = env._session.addTask.mock.calls[0][0];
    expect(broadcast.id).toBeDefined();
    expect(broadcast.title).toBe("comprar leche");
    expect(broadcast).not.toHaveProperty("intent");
  });

  it("PATCH broadcasts task_updated with the full row", async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    const created = await worker.fetch(
      new Request("https://timon.example/api/tasks", {
        method: "POST",
        headers: authHeaders(env),
        body: JSON.stringify({ text: "buy milk" }),
      }),
      env
    );
    const { task_id } = await created.json();
    const patched = await worker.fetch(
      new Request(`https://timon.example/api/tasks/${task_id}`, {
        method: "PATCH",
        headers: authHeaders(env),
        body: JSON.stringify({ status: "done" }),
      }),
      env
    );
    expect(patched.status).toBe(200);
    expect(env._session.updateTask).toHaveBeenCalled();
    const broadcast = env._session.updateTask.mock.calls.at(-1)[0];
    expect(broadcast.id).toBe(task_id);
    expect(broadcast.status).toBe("done");
    expect(broadcast.title).toBeDefined();
  });

  it("DELETE broadcasts task_deleted with the full row", async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    const created = await worker.fetch(
      new Request("https://timon.example/api/tasks", {
        method: "POST",
        headers: authHeaders(env),
        body: JSON.stringify({ text: "buy milk" }),
      }),
      env
    );
    const { task_id } = await created.json();
    const deleted = await worker.fetch(
      new Request(`https://timon.example/api/tasks/${task_id}`, {
        method: "DELETE",
        headers: authHeaders(env),
      }),
      env
    );
    expect(deleted.status).toBe(200);
    expect(env._session.removeTask).toHaveBeenCalledTimes(1);
    const broadcast = env._session.removeTask.mock.calls[0][0];
    expect(broadcast.id).toBe(task_id);
    expect(broadcast.title).toBeDefined();
  });

  it("dependency changes emit task_updated for both tasks", async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    const a = await worker.fetch(
      new Request("https://timon.example/api/tasks", {
        method: "POST",
        headers: authHeaders(env),
        body: JSON.stringify({ text: "task a" }),
      }),
      env
    );
    const b = await worker.fetch(
      new Request("https://timon.example/api/tasks", {
        method: "POST",
        headers: authHeaders(env),
        body: JSON.stringify({ text: "task b" }),
      }),
      env
    );
    const { task_id: idA } = await a.json();
    const { task_id: idB } = await b.json();
    env._session.updateTask.mockClear();

    const added = await worker.fetch(
      new Request(`https://timon.example/api/tasks/${idA}/dependencies`, {
        method: "POST",
        headers: authHeaders(env),
        body: JSON.stringify({ depends_on_id: idB }),
      }),
      env
    );
    expect(added.status).toBe(201);
    const updatedIds = env._session.updateTask.mock.calls.map(
      (call) => call[0].id
    );
    expect(updatedIds).toEqual(expect.arrayContaining([idA, idB]));

    env._session.updateTask.mockClear();
    const removed = await worker.fetch(
      new Request(
        `https://timon.example/api/tasks/${idA}/dependencies/${idB}`,
        { method: "DELETE", headers: authHeaders(env) }
      ),
      env
    );
    expect(removed.status).toBe(200);
    const removedIds = env._session.updateTask.mock.calls.map(
      (call) => call[0].id
    );
    expect(removedIds).toEqual(expect.arrayContaining([idA, idB]));
  });
});
