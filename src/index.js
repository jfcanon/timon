import { transcribeAudio } from "./lib/transcribe.js";
import { extractIntent } from "./lib/intents.js";
import { createTask, ensureSchema, getTaskWithContext } from "./lib/store.js";
import { SessionDO } from "./durable-objects/session.js";

export { SessionDO };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/voice" && request.method === "POST") {
      return handleVoice(request, env);
    }

    if (url.pathname === "/api/tasks" && request.method === "POST") {
      return handleCreateTask(request, env);
    }

    if (url.pathname === "/api/ws") {
      return handleWebSocketConnect(request, env);
    }

    if (url.pathname.startsWith("/api/tasks/") && request.method === "GET") {
      const taskId = url.pathname.split("/api/tasks/")[1];
      return handleGetTask(taskId, env);
    }

    if (url.pathname === "/healthz") {
      return new Response(
        JSON.stringify({ status: "ok", service: "timon-worker" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    }

    return new Response("Not found", { status: 404 });
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
  const taskId = await createTask(db, intent);

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

function verifyApiKey(request, env) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7);
  return token === env.TIMON_API_KEY;
}

async function handleCreateTask(request, env) {
  if (!verifyApiKey(request, env)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
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

  const { text, device_id, ts } = body;
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
