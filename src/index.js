import { transcribeAudio } from "./lib/transcribe.js";
import { extractIntent } from "./lib/intents.js";
import {
  createTask,
  ensureSchema,
  getTaskWithContext,
  getDecoratedTask,
  listTasks,
  updateTask,
  deleteTask,
  addDependency,
  removeDependency,
} from "./lib/store.js";
import { SessionDO } from "./durable-objects/session.js";
import {
  isAuthorized,
  createSessionToken,
  sessionCookieValue,
  clearedSessionCookieValue,
  timingSafeEqual,
} from "./lib/auth.js";
import { checkRateLimit, resetRateLimit, maybeCleanup } from "./lib/rate-limit.js";

export { SessionDO };

const SESSION_NAME = "default";

function sessionStub(env) {
  return env.SESSION.get(env.SESSION.idFromName(SESSION_NAME));
}

async function broadcastAdded(env, task) {
  if (!task) return;
  await sessionStub(env).addTask(task);
}

async function broadcastUpdated(env, task) {
  if (!task) return;
  await sessionStub(env).updateTask(task);
}

async function broadcastDeleted(env, task) {
  if (!task) return;
  await sessionStub(env).removeTask(task);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return new Response(
        JSON.stringify({ status: "ok", service: "timon-worker" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    }

    // Browser auth: these must be reachable WITHOUT a Bearer key (the browser
    // has none). They sit outside the /api/* gate on purpose.
    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      return handleLogin(request, env);
    }
    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      return handleLogout(request, env);
    }

    // Scope auth gate to /api and /api/* only. Accepts either a Bearer key
    // (ESP32 / apollo) or a session cookie (browser) — the voice path is
    // byte-for-byte unaffected.
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (!(await isAuthorized(request, env))) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.pathname === "/api/voice" && request.method === "POST") {
        return handleVoice(request, env);
      }

      if (url.pathname === "/api/tasks" && request.method === "GET") {
        return handleListTasks(url, env);
      }

      if (url.pathname === "/api/tasks" && request.method === "POST") {
        return handleCreateTask(request, env);
      }

      if (url.pathname === "/api/ws") {
        return handleWebSocketConnect(request, env);
      }

      const depPostMatch = url.pathname.match(
        /^\/api\/tasks\/([^/]+)\/dependencies$/
      );
      if (depPostMatch && request.method === "POST") {
        return handleAddDependency(request, decodeURIComponent(depPostMatch[1]), env);
      }

      const depDelMatch = url.pathname.match(
        /^\/api\/tasks\/([^/]+)\/dependencies\/([^/]+)$/
      );
      if (depDelMatch && request.method === "DELETE") {
        return handleRemoveDependency(
          decodeURIComponent(depDelMatch[1]),
          decodeURIComponent(depDelMatch[2]),
          env
        );
      }

      const taskMatch = url.pathname.match(/^\/api\/tasks\/(.+)$/);
      if (taskMatch) {
        const taskId = taskMatch[1];
        if (request.method === "GET") {
          return handleGetTask(taskId, env);
        }
        if (request.method === "PATCH") {
          return handlePatchTask(request, taskId, env);
        }
        if (request.method === "DELETE") {
          return handleDeleteTask(taskId, env);
        }
      }

      // Unknown API route — do not fall through to assets
      return new Response("Not found", { status: 404 });
    }

    // Non-API paths (SPA deep links, root) → serve app shell from assets
    return env.ASSETS.fetch(request);
  },
};

async function handleWebSocketConnect(request, env) {
  // Origin check: WebSocket handshakes are not subject to CORS, so we need
  // an explicit Origin allowlist check to prevent cross-site WebSocket hijacking.
  const origin = request.headers.get("origin");
  if (origin) {
    const url = new URL(request.url);
    const allowedOrigins = [
      url.origin,
      "https://timon.ygdcbtmc4u.uk",
      "https://timon-worker.ygdcbtmc4u.workers.dev",
    ];
    if (!allowedOrigins.includes(origin)) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
  }

  return sessionStub(env).fetch(request);
}

// Browser login: compare the password against the APP_PASSWORD Worker secret,
// then set a signed HttpOnly session cookie. No Bearer key ever reaches the JS.
async function handleLogin(request, env) {
  if (!env.APP_PASSWORD || !env.SESSION_SECRET) {
    return new Response(JSON.stringify({ error: "auth_unavailable" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  // Rate limit by IP
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const rateKey = `login:${ip}`;
  const { allowed, retryAfter } = checkRateLimit(rateKey);
  maybeCleanup();

  if (!allowed) {
    return new Response(JSON.stringify({ error: "too_many_attempts" }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(retryAfter),
      },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const password = body && body.password;
  if (!timingSafeEqual(password, env.APP_PASSWORD)) {
    return new Response(JSON.stringify({ error: "invalid_credentials" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  // Successful login resets rate limit
  resetRateLimit(rateKey);

  try {
    const token = await createSessionToken(env, "owner");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": sessionCookieValue(token),
      },
    });
  } catch {
    return new Response(JSON.stringify({ error: "auth_unavailable" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}

async function handleLogout(request, env) {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": clearedSessionCookieValue(),
    },
  });
}

async function handleVoice(request, env) {
  const contentType = request.headers.get("content-type") || "";

  let audioBuffer;
  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const audioFile = formData.get("audio");
    if (!audioFile) {
      return new Response(JSON.stringify({ error: "no_audio_provided" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    audioBuffer = await audioFile.arrayBuffer();
  } else {
    audioBuffer = await request.arrayBuffer();
  }

  const transcription = await transcribeAudio(audioBuffer, env);
  if (transcription.error) {
    return new Response(JSON.stringify(transcription), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const intent = await extractIntent(transcription.text, env);

  const db = env.TIMON_META;
  await ensureSchema(db);
  const deviceId = request.headers.get("x-device-id") || null;
  const taskId = await createTask(db, intent, "owner", deviceId);
  const task = await getDecoratedTask(db, taskId);
  await broadcastAdded(env, task);

  return new Response(
    JSON.stringify({
      task_id: taskId,
      intent,
      transcription: transcription.text,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    }
  );
}

async function handleCreateTask(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const { text, device_id, ts, priority, category, parent_id } = body;
  if (!text || typeof text !== "string" || text.trim() === "") {
    return new Response(JSON.stringify({ error: "text_required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  // `ts` carries the reminder/due time from apollo's timon_create_task
  // (remind_at) and is authoritative: until NID-469 lands, extractIntent is a
  // heuristic that always returns date:null, so without this the due date
  // never reaches the task row.
  let dueDate = null;
  if (ts !== undefined && ts !== null && ts !== "") {
    const parsedDate = new Date(ts);
    if (Number.isNaN(parsedDate.getTime())) {
      return new Response(JSON.stringify({ error: "invalid_ts" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    dueDate = parsedDate.toISOString();
  }

  const db = env.TIMON_META;
  await ensureSchema(db);

  const intent = await extractIntent(text.trim(), env);
  if (dueDate) intent.date = dueDate;
  // Explicit contract values override the LLM's extraction (owner decision, NID-470).
  if (priority !== undefined && priority !== null && priority !== "") {
    if (!["high", "medium", "low"].includes(priority)) {
      return new Response(JSON.stringify({ error: "invalid_priority" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    intent.priority = priority;
  }
  if (category !== undefined && category !== null) {
    if (typeof category !== "string") {
      return new Response(JSON.stringify({ error: "invalid_category" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    intent.category = category;
  }
  // Validate parent exists if provided
  if (parent_id !== undefined && parent_id !== null && parent_id !== "") {
    const parentExists = await db
      .prepare("SELECT id FROM tasks WHERE id = ?")
      .bind(parent_id)
      .first();
    if (!parentExists) {
      return new Response(JSON.stringify({ error: "parent_not_found" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    intent.parent_id = parent_id;
  }
  const taskId = await createTask(db, intent, "owner", device_id || null);
  const task = await getDecoratedTask(db, taskId);
  await broadcastAdded(env, task);

  return new Response(
    JSON.stringify({ task_id: taskId, task, status: "created" }),
    {
      status: 201,
      headers: { "content-type": "application/json" },
    }
  );
}

async function handleGetTask(taskId, env) {
  const db = env.TIMON_META;
  await ensureSchema(db);
  const context = await getTaskWithContext(db, taskId);

  if (!context) {
    return new Response(JSON.stringify({ error: "task_not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify(context), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function handleListTasks(url, env) {
  const db = env.TIMON_META;
  await ensureSchema(db);

  const status = url.searchParams.get("status") || undefined;
  const category = url.searchParams.get("category") || undefined;
  const parentIdParam = url.searchParams.get("parent_id");

  let parentId;
  if (parentIdParam === "null") {
    parentId = null;
  } else if (parentIdParam !== undefined && parentIdParam !== null) {
    parentId = parentIdParam;
  }

  const tasks = await listTasks(db, {
    status,
    category,
    parent_id: parentId,
  });

  return new Response(JSON.stringify({ tasks }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function handlePatchTask(request, taskId, env) {
  const db = env.TIMON_META;
  await ensureSchema(db);

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (body.status !== undefined) {
    if (!["pending", "in_progress", "done", "cancelled"].includes(body.status)) {
      return new Response(JSON.stringify({ error: "invalid_status" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
  }

  if (body.priority !== undefined) {
    if (body.priority !== null && !["high", "medium", "low"].includes(body.priority)) {
      return new Response(JSON.stringify({ error: "invalid_priority" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
  }

  const existing = await db
    .prepare(`SELECT * FROM tasks WHERE id = ?`)
    .bind(taskId)
    .first();
  if (!existing) {
    return new Response(JSON.stringify({ error: "task_not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const updates = {};
  for (const key of ["title", "parent_id", "due_date", "priority", "category", "status"]) {
    if (body[key] !== undefined) {
      updates[key] = body[key];
    }
  }

  if (body.status === "done") {
    updates.completed_at = new Date().toISOString();
  } else if (body.status !== undefined && body.status !== "done") {
    updates.completed_at = null;
  }

  await updateTask(db, taskId, updates);

  const task = await getDecoratedTask(db, taskId);
  await broadcastUpdated(env, task);

  if (updates.parent_id !== undefined) {
    if (existing.parent_id && existing.parent_id !== updates.parent_id) {
      await broadcastUpdated(env, await getDecoratedTask(db, existing.parent_id));
    }
    if (updates.parent_id) {
      await broadcastUpdated(env, await getDecoratedTask(db, updates.parent_id));
    }
  }

  return new Response(JSON.stringify({ task }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function handleDeleteTask(taskId, env) {
  const db = env.TIMON_META;
  await ensureSchema(db);

  const existing = await getDecoratedTask(db, taskId);
  if (!existing) {
    return new Response(JSON.stringify({ error: "task_not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  await deleteTask(db, taskId);
  await broadcastDeleted(env, existing);

  return new Response(JSON.stringify({ deleted: taskId }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function handleAddDependency(request, taskId, env) {
  const db = env.TIMON_META;
  await ensureSchema(db);

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const dependsOnId = body?.depends_on_id;
  if (!dependsOnId || typeof dependsOnId !== "string" || dependsOnId.trim() === "") {
    return new Response(JSON.stringify({ error: "depends_on_id_required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const task = await db
    .prepare("SELECT id FROM tasks WHERE id = ?")
    .bind(taskId)
    .first();
  if (!task) {
    return new Response(JSON.stringify({ error: "task_not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const dependsOn = await db
    .prepare("SELECT id FROM tasks WHERE id = ?")
    .bind(dependsOnId)
    .first();
  if (!dependsOn) {
    return new Response(JSON.stringify({ error: "depends_on_not_found" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  try {
    await addDependency(db, taskId, dependsOnId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg === "cannot depend on self") {
      return new Response(JSON.stringify({ error: "cannot_depend_on_self" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (msg === "dependency cycle detected") {
      return new Response(
        JSON.stringify({ error: "dependency_cycle_detected" }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        }
      );
    }
    throw err;
  }

  await broadcastUpdated(env, await getDecoratedTask(db, taskId));
  await broadcastUpdated(env, await getDecoratedTask(db, dependsOnId));

  return new Response(
    JSON.stringify({
      task_id: taskId,
      depends_on_id: dependsOnId,
      status: "created",
    }),
    {
      status: 201,
      headers: { "content-type": "application/json" },
    }
  );
}

async function handleRemoveDependency(taskId, dependsOnId, env) {
  const db = env.TIMON_META;
  await ensureSchema(db);

  const task = await db
    .prepare("SELECT id FROM tasks WHERE id = ?")
    .bind(taskId)
    .first();
  if (!task) {
    return new Response(JSON.stringify({ error: "task_not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const result = await removeDependency(db, taskId, dependsOnId);
  const removed = (result?.meta?.changes ?? 0) > 0;

  if (removed) {
    await broadcastUpdated(env, await getDecoratedTask(db, taskId));
    await broadcastUpdated(env, await getDecoratedTask(db, dependsOnId));
  }

  return new Response(JSON.stringify({ removed }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}