import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function makeEnv(overrides = {}) {
  const mockDB = {
    prepare: vi.fn(() => ({
      run: vi.fn(async () => {}),
      all: vi.fn(async () => ({ results: [] })),
      bind: vi.fn(() => ({
        run: vi.fn(async () => {}),
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
      })),
    })),
  };
  const mockSession = {
    addTask: vi.fn(async () => ({})),
  };
  const mockSessionDO = {
    idFromName: vi.fn(() => "mock-id"),
    get: vi.fn(() => mockSession),
  };
  const mockAssets = {
    fetch: vi.fn(async (request) => {
      return new Response("<html>Timon shell</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }),
  };

  return {
    TIMON_API_KEY: "test-api-key-123",
    TIMON_META: mockDB,
    SESSION: mockSessionDO,
    ASSETS: mockAssets,
    ...overrides,
  };
}

function makeAuthHeaders(env) {
  return {
    authorization: `Bearer ${env.TIMON_API_KEY}`,
  };
}

function makeRequest(url, env, options = {}) {
  return new Request(url, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      ...makeAuthHeaders(env),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

describe("Auth on all /api/* routes", () => {
  let worker;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
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

  it("should return 401 for GET /api/tasks without auth", async () => {
    const env = makeEnv();
    const request = new Request("https://timon-worker.example.com/api/tasks", {
      method: "GET",
    });

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe("unauthorized");
  });

  it("should return 401 for GET /api/tasks/:id without auth", async () => {
    const env = makeEnv();
    const request = new Request(
      "https://timon-worker.example.com/api/tasks/task-123",
      {
        method: "GET",
      }
    );

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(401);
  });

  it("should return 401 for PATCH /api/tasks/:id without auth", async () => {
    const env = makeEnv();
    const request = new Request(
      "https://timon-worker.example.com/api/tasks/task-123",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      }
    );

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(401);
  });

  it("should return 401 for DELETE /api/tasks/:id without auth", async () => {
    const env = makeEnv();
    const request = new Request(
      "https://timon-worker.example.com/api/tasks/task-123",
      {
        method: "DELETE",
      }
    );

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(401);
  });

  it("should return 401 for POST /api/voice without auth", async () => {
    const env = makeEnv();
    const request = new Request(
      "https://timon-worker.example.com/api/voice",
      {
        method: "POST",
        headers: { "content-type": "audio/wav" },
        body: new ArrayBuffer(100),
      }
    );

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(401);
  });

  it("should return 401 for GET /api/ws without auth", async () => {
    const env = makeEnv();
    const request = new Request(
      "https://timon-worker.example.com/api/ws",
      {
        method: "GET",
      }
    );

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(401);
  });

  it("should allow /healthz without auth", async () => {
    const env = makeEnv();
    const request = new Request(
      "https://timon-worker.example.com/healthz",
      {
        method: "GET",
      }
    );

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);
  });
});

describe("App shell / deep links (non-API paths)", () => {
  let worker;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
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

  it("should serve shell for GET / (root)", async () => {
    const env = makeEnv();
    const request = new Request("https://timon-worker.example.com/", {
      method: "GET",
    });

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);
    expect(env.ASSETS.fetch).toHaveBeenCalled();
  });

  it("should serve shell for deep link GET /app/anything", async () => {
    const env = makeEnv();
    const request = new Request(
      "https://timon-worker.example.com/app/anything",
      {
        method: "GET",
      }
    );

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);
    expect(env.ASSETS.fetch).toHaveBeenCalled();
  });

  it("should serve shell for deep link GET /app/task/123", async () => {
    const env = makeEnv();
    const request = new Request(
      "https://timon-worker.example.com/app/task/123",
      {
        method: "GET",
      }
    );

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);
    expect(env.ASSETS.fetch).toHaveBeenCalled();
  });

  it("should return 401 for GET /api/tasks without auth", async () => {
    const env = makeEnv();
    const request = new Request(
      "https://timon-worker.example.com/api/tasks",
      {
        method: "GET",
      }
    );

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe("unauthorized");
  });

  it("should return 200 for GET /api/tasks with valid Bearer", async () => {
    const env = makeEnv();
    const request = new Request(
      "https://timon-worker.example.com/api/tasks",
      {
        method: "GET",
        headers: { authorization: `Bearer ${env.TIMON_API_KEY}` },
      }
    );

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);
  });

  it("should return 404 for unknown API route GET /api/unknown", async () => {
    const env = makeEnv();
    const request = new Request(
      "https://timon-worker.example.com/api/unknown",
      {
        method: "GET",
        headers: { authorization: `Bearer ${env.TIMON_API_KEY}` },
      }
    );

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(404);
  });

  it("should return 401 for GET /api (bare) without auth", async () => {
    const env = makeEnv();
    const request = new Request("https://timon-worker.example.com/api", {
      method: "GET",
    });

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe("unauthorized");
  });

  it("should return 404 for GET /api (bare) with valid Bearer", async () => {
    const env = makeEnv();
    const request = new Request(
      "https://timon-worker.example.com/api",
      {
        method: "GET",
        headers: { authorization: `Bearer ${env.TIMON_API_KEY}` },
      }
    );

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(404);
  });
});

describe("Config assertion", () => {
  it("should have correct assets config in wrangler.toml", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const wranglerPath = path.resolve(__dirname, "../wrangler.toml");
    const content = fs.readFileSync(wranglerPath, "utf-8");

    expect(content).toContain('[assets]');
    expect(content).toContain('binding = "ASSETS"');
    expect(content).toContain('directory = "app/dist"');
    expect(content).toContain('not_found_handling = "single-page-application"');
  });
});

describe("GET /api/tasks (list)", () => {
  let worker;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
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

  it("should return tasks list with subtask_count and blocked_by_count", async () => {
    const env = makeEnv();
    const mockTasks = [
      {
        id: "task-1",
        title: "Goal",
        parent_id: null,
        status: "pending",
        priority: "high",
        category: "work",
        created_at: "2026-08-27T00:00:00Z",
        updated_at: "2026-08-27T00:00:00Z",
      },
      {
        id: "task-2",
        title: "Prerequisite",
        parent_id: "task-1",
        status: "pending",
        priority: "medium",
        category: "work",
        created_at: "2026-08-27T00:00:01Z",
        updated_at: "2026-08-27T00:00:01Z",
      },
    ];

    // The decoration lookups take no bound parameters — they read the two
    // small index tables whole (see decorateTasks in src/lib/store.js).
    const mockIndexRows = [
      { id: "task-1", title: "Goal", parent_id: null, status: "pending" },
      { id: "task-2", title: "Prerequisite", parent_id: "task-1", status: "pending" },
      { id: "task-3", title: "Buy the paint", parent_id: null, status: "pending" },
    ];
    const mockDepRows = [{ task_id: "task-1", depends_on_id: "task-3" }];

    env.TIMON_META.prepare = vi.fn((sql) => {
      const empty = () => ({
        run: vi.fn(async () => {}),
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
      });
      const rows = (results) => ({
        run: vi.fn(async () => {}),
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results })),
      });

      if (sql.includes("SELECT id, title, parent_id, status FROM tasks")) {
        return rows(mockIndexRows);
      }
      if (sql.includes("SELECT task_id, depends_on_id FROM dependencies")) {
        return rows(mockDepRows);
      }
      return {
        ...empty(),
        bind: vi.fn(() => {
          if (sql.includes("SELECT * FROM tasks WHERE 1=1")) return rows(mockTasks);
          return empty();
        }),
      };
    });

    const request = new Request(
      "https://timon-worker.example.com/api/tasks",
      {
        method: "GET",
        headers: makeAuthHeaders(env),
      }
    );
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.tasks).toHaveLength(2);
    expect(data.tasks[0].subtask_count).toBe(1);
    expect(data.tasks[0].blocked_by_count).toBe(1);
    expect(data.tasks[1].subtask_count).toBe(0);
    expect(data.tasks[1].blocked_by_count).toBe(0);
    // The list card names its blockers, it does not merely count them.
    expect(data.tasks[0].blocked_by).toEqual([
      { id: "task-3", title: "Buy the paint", status: "pending" },
    ]);
    // An open blocker counts in both fields.
    expect(data.tasks[0].blocked_by_open_count).toBe(1);
    expect(data.tasks[1].blocked_by).toEqual([]);
    // …and carries its parent's title for the inline breadcrumb.
    expect(data.tasks[0].parent_title).toBeNull();
    expect(data.tasks[1].parent_title).toBe("Goal");
  });

  it("should filter by status", async () => {
    const env = makeEnv();
    env.TIMON_META.prepare = vi.fn(() => ({
      run: vi.fn(async () => {}),
      all: vi.fn(async () => ({ results: [] })),
      bind: vi.fn(() => ({
        run: vi.fn(async () => {}),
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
      })),
    }));

    const request = new Request(
      "https://timon-worker.example.com/api/tasks?status=pending",
      {
        method: "GET",
        headers: makeAuthHeaders(env),
      }
    );
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.tasks).toEqual([]);
  });
});

describe("GET /api/tasks/:id (context)", () => {
  let worker;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
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

  it("should return 404 for non-existent task", async () => {
    const env = makeEnv();
    env.TIMON_META.prepare = vi.fn(() => ({
      run: vi.fn(async () => {}),
      all: vi.fn(async () => ({ results: [] })),
      bind: vi.fn(() => ({
        run: vi.fn(async () => {}),
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
      })),
    }));

    const request = new Request(
      "https://timon-worker.example.com/api/tasks/non-existent",
      {
        method: "GET",
        headers: makeAuthHeaders(env),
      }
    );
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe("task_not_found");
  });

  it("should return task context with blocks array", async () => {
    const env = makeEnv();
    const mockTask = {
      id: "task-1",
      title: "Goal",
      parent_id: null,
      status: "pending",
      priority: "high",
      category: "work",
      created_at: "2026-08-27T00:00:00Z",
      updated_at: "2026-08-27T00:00:00Z",
    };

    const mockParent = null;
    const mockSiblings = [];
    const mockSubtasks = [
      {
        id: "task-2",
        title: "Prerequisite",
        parent_id: "task-1",
        status: "pending",
        priority: "medium",
        category: "work",
        created_at: "2026-08-27T00:00:01Z",
        updated_at: "2026-08-27T00:00:01Z",
      },
    ];
    const mockBlockers = [];
    const mockBlocks = [
      {
        id: "task-3",
        title: "Dependent",
        parent_id: null,
        status: "pending",
        priority: "low",
        category: "work",
        created_at: "2026-08-27T00:00:02Z",
        updated_at: "2026-08-27T00:00:02Z",
      },
    ];

    let callCount = 0;
    env.TIMON_META.prepare = vi.fn((sql) => {
      return {
        run: vi.fn(async () => {}),
        all: vi.fn(async () => ({ results: [] })),
        bind: vi.fn((...args) => {
          if (sql.includes("SELECT * FROM tasks WHERE id = ?")) {
            callCount++;
            if (callCount === 1) {
              return {
                run: vi.fn(async () => {}),
                first: vi.fn(async () => mockTask),
                all: vi.fn(async () => ({ results: [] })),
              };
            }
            if (callCount === 2) {
              return {
                run: vi.fn(async () => {}),
                first: vi.fn(async () => mockParent),
                all: vi.fn(async () => ({ results: [] })),
              };
            }
          }
          if (sql.includes("parent_id = ? AND id != ?")) {
            return {
              run: vi.fn(async () => {}),
              first: vi.fn(async () => null),
              all: vi.fn(async () => ({ results: mockSiblings })),
            };
          }
          if (
            sql.includes("parent_id = ?") &&
            !sql.includes("IS NULL")
          ) {
            return {
              run: vi.fn(async () => {}),
              first: vi.fn(async () => null),
              all: vi.fn(async () => ({ results: mockSubtasks })),
            };
          }
          if (sql.includes("d.depends_on_id = t.id") && sql.includes("d.task_id = ?")) {
            return {
              run: vi.fn(async () => {}),
              first: vi.fn(async () => null),
              all: vi.fn(async () => ({ results: mockBlockers })),
            };
          }
          if (sql.includes("d.task_id = t.id") && sql.includes("d.depends_on_id = ?")) {
            return {
              run: vi.fn(async () => {}),
              first: vi.fn(async () => null),
              all: vi.fn(async () => ({ results: mockBlocks })),
            };
          }
          return {
            run: vi.fn(async () => {}),
            first: vi.fn(async () => null),
            all: vi.fn(async () => ({ results: [] })),
          };
        }),
      };
    });

    const request = new Request(
      "https://timon-worker.example.com/api/tasks/task-1",
      {
        method: "GET",
        headers: makeAuthHeaders(env),
      }
    );
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.task.id).toBe("task-1");
    expect(data.parent).toBeNull();
    expect(data.siblings).toEqual([]);
    expect(data.subtasks).toHaveLength(1);
    expect(data.subtasks[0].id).toBe("task-2");
    expect(data.blockers).toEqual([]);
    expect(data.blocks).toHaveLength(1);
    expect(data.blocks[0].id).toBe("task-3");
  });
});

describe("PATCH /api/tasks/:id", () => {
  let worker;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
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

  it("should return 404 for non-existent task", async () => {
    const env = makeEnv();
    env.TIMON_META.prepare = vi.fn(() => ({
      run: vi.fn(async () => {}),
      all: vi.fn(async () => ({ results: [] })),
      bind: vi.fn(() => ({
        run: vi.fn(async () => {}),
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
      })),
    }));

    const request = new Request(
      "https://timon-worker.example.com/api/tasks/non-existent",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          ...makeAuthHeaders(env),
        },
        body: JSON.stringify({ status: "done" }),
      }
    );
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(404);
  });

  it("should update task status and set completed_at", async () => {
    const env = makeEnv();
    const mockTask = {
      id: "task-1",
      title: "Goal",
      parent_id: null,
      status: "done",
      priority: "high",
      category: "work",
      created_at: "2026-08-27T00:00:00Z",
      updated_at: "2026-08-27T00:00:00Z",
      completed_at: "2026-08-27T01:00:00Z",
    };

    let callCount = 0;
    env.TIMON_META.prepare = vi.fn((sql) => {
      return {
        run: vi.fn(async () => {}),
        all: vi.fn(async () => ({ results: [] })),
        bind: vi.fn((...args) => {
          if (sql.includes("SELECT id FROM tasks WHERE id = ?")) {
            return {
              run: vi.fn(async () => {}),
              first: vi.fn(async () => ({ id: "task-1" })),
              all: vi.fn(async () => ({ results: [] })),
            };
          }
          if (sql.includes("UPDATE tasks SET")) {
            return {
              run: vi.fn(async () => {}),
              first: vi.fn(async () => null),
              all: vi.fn(async () => ({ results: [] })),
            };
          }
          if (sql.includes("INSERT INTO task_events")) {
            return {
              run: vi.fn(async () => {}),
              first: vi.fn(async () => null),
              all: vi.fn(async () => ({ results: [] })),
            };
          }
          if (sql.includes("SELECT * FROM tasks WHERE id = ?")) {
            return {
              run: vi.fn(async () => {}),
              first: vi.fn(async () => mockTask),
              all: vi.fn(async () => ({ results: [] })),
            };
          }
          return {
            run: vi.fn(async () => {}),
            first: vi.fn(async () => null),
            all: vi.fn(async () => ({ results: [] })),
          };
        }),
      };
    });

    const request = new Request(
      "https://timon-worker.example.com/api/tasks/task-1",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          ...makeAuthHeaders(env),
        },
        body: JSON.stringify({ status: "done" }),
      }
    );
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.task.status).toBe("done");
  });

  it("should return 400 for invalid status", async () => {
    const env = makeEnv();
    env.TIMON_META.prepare = vi.fn(() => ({
      run: vi.fn(async () => {}),
      all: vi.fn(async () => ({ results: [] })),
      bind: vi.fn(() => ({
        run: vi.fn(async () => {}),
        first: vi.fn(async () => ({ id: "task-1" })),
        all: vi.fn(async () => ({ results: [] })),
      })),
    }));

    const request = new Request(
      "https://timon-worker.example.com/api/tasks/task-1",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          ...makeAuthHeaders(env),
        },
        body: JSON.stringify({ status: "invalid_status" }),
      }
    );
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("invalid_status");
  });

  it("should return 400 for invalid priority", async () => {
    const env = makeEnv();
    env.TIMON_META.prepare = vi.fn(() => ({
      run: vi.fn(async () => {}),
      all: vi.fn(async () => ({ results: [] })),
      bind: vi.fn(() => ({
        run: vi.fn(async () => {}),
        first: vi.fn(async () => ({ id: "task-1" })),
        all: vi.fn(async () => ({ results: [] })),
      })),
    }));

    const request = new Request(
      "https://timon-worker.example.com/api/tasks/task-1",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          ...makeAuthHeaders(env),
        },
        body: JSON.stringify({ priority: "urgent" }),
      }
    );
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("invalid_priority");
  });

  it("should return 400 on invalid JSON body", async () => {
    const env = makeEnv();
    env.TIMON_META.prepare = vi.fn(() => ({
      run: vi.fn(async () => {}),
      all: vi.fn(async () => ({ results: [] })),
      bind: vi.fn(() => ({
        run: vi.fn(async () => {}),
        first: vi.fn(async () => ({ id: "task-1" })),
        all: vi.fn(async () => ({ results: [] })),
      })),
    }));

    const request = new Request(
      "https://timon-worker.example.com/api/tasks/task-1",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          ...makeAuthHeaders(env),
        },
        body: "not-json",
      }
    );
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("invalid_json");
  });
});

describe("DELETE /api/tasks/:id", () => {
  let worker;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
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

  it("should return 404 for non-existent task", async () => {
    const env = makeEnv();
    env.TIMON_META.prepare = vi.fn(() => ({
      run: vi.fn(async () => {}),
      all: vi.fn(async () => ({ results: [] })),
      bind: vi.fn(() => ({
        run: vi.fn(async () => {}),
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
      })),
    }));

    const request = new Request(
      "https://timon-worker.example.com/api/tasks/non-existent",
      {
        method: "DELETE",
        headers: makeAuthHeaders(env),
      }
    );
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(404);
  });

  it("should delete task and return success", async () => {
    const env = makeEnv();
    env.TIMON_META.prepare = vi.fn(() => ({
      run: vi.fn(async () => {}),
      all: vi.fn(async () => ({ results: [] })),
      bind: vi.fn(() => ({
        run: vi.fn(async () => {}),
        first: vi.fn(async () => ({ id: "task-1" })),
        all: vi.fn(async () => ({ results: [] })),
      })),
    }));

    const request = new Request(
      "https://timon-worker.example.com/api/tasks/task-1",
      {
        method: "DELETE",
        headers: makeAuthHeaders(env),
      }
    );
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.deleted).toBe("task-1");
  });
});

describe("POST /api/tasks", () => {
  let worker;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
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

  it("should accept priority and category in body", async () => {
    const env = makeEnv();
    const mockTask = {
      id: "mock-task-id",
      title: "buy milk",
      parent_id: null,
      due_date: null,
      priority: "high",
      category: "shopping",
      created_at: "now",
      updated_at: "now",
    };

    let capturedTaskArgs = null;
    const chainable = {
      run: vi.fn(async () => {}),
      first: vi.fn(async () => mockTask),
      all: vi.fn(async () => ({ results: [] })),
    };
    const bindFn = vi.fn((...args) => {
      if (args.length === 8) capturedTaskArgs = args;
      return chainable;
    });
    env.TIMON_META.prepare = vi.fn(() => ({
      run: vi.fn(async () => {}),
      all: vi.fn(async () => ({ results: [] })),
      bind: bindFn,
    }));

    const request = new Request(
      "https://timon-worker.example.com/api/tasks",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...makeAuthHeaders(env),
        },
        body: JSON.stringify({
          text: "buy milk",
          priority: "high",
          category: "shopping",
        }),
      }
    );
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(201);
    expect(capturedTaskArgs[4]).toBe("high");
    expect(capturedTaskArgs[5]).toBe("shopping");
  });
});
