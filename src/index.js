import { transcribeAudio } from "./lib/transcribe.js";
import { extractIntent } from "./lib/intents.js";
import {
  createTask,
  ensureSchema,
  getTaskWithContext,
  listTasks,
  updateTask,
  deleteTask,
} from "./lib/store.js";
import { SessionDO } from "./durable-objects/session.js";

export { SessionDO };

function verifyApiKey(request, env) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7);
  return token === env.TIMON_API_KEY;
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

    // Scope auth gate to /api and /api/* only
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (!verifyApiKey(request, env)) {
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
  const sessionId = request.headers.get("x-session-id") || "default";
  const id = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(id);

  return stub.fetch(request);
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

  const sessionId = request.headers.get("x-session-id") || "default";
  const id = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(id);
  await stub.addTask(taskId, intent);

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

  const { text, device_id, ts, priority, category } = body;
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
  const taskId = await createTask(db, intent, "owner", device_id || null);

  const sessionId = request.headers.get("x-session-id") || "default";
  const id = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(id);
  await stub.addTask(taskId, intent);

  const task = await db
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .bind(taskId)
    .first();

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
    if (!["high", "medium", "low"].includes(body.priority)) {
      return new Response(JSON.stringify({ error: "invalid_priority" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
  }

  const existing = await db
    .prepare(`SELECT id FROM tasks WHERE id = ?`)
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

  const task = await db
    .prepare(`SELECT * FROM tasks WHERE id = ?`)
    .bind(taskId)
    .first();

  return new Response(JSON.stringify({ task }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function handleDeleteTask(taskId, env) {
  const db = env.TIMON_META;
  await ensureSchema(db);

  const existing = await db
    .prepare(`SELECT id FROM tasks WHERE id = ?`)
    .bind(taskId)
    .first();
  if (!existing) {
    return new Response(JSON.stringify({ error: "task_not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  await deleteTask(db, taskId);

  return new Response(JSON.stringify({ deleted: taskId }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}