// Every call to the gated API rides the HttpOnly session cookie set by
// POST /api/auth/login (NID-526). The browser never holds the Bearer key.

import type { Task, TaskContext } from "./format";

export class ApiError extends Error {
  readonly status: number;
  readonly offline: boolean;

  constructor(message: string, status: number, offline = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.offline = offline;
  }
}

/** A 401 means the session is gone; the shell drops back to the login view. */
export class UnauthorizedError extends ApiError {
  constructor() {
    super("unauthorized", 401);
    this.name = "UnauthorizedError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    // Spread init first, then set headers and credentials last to ensure they
    // are never overwritten by caller-provided values.
    const { headers: initHeaders, ...rest } = init;
    res = await fetch(path, {
      ...rest,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(initHeaders ?? {}) },
    });
  } catch {
    throw new ApiError(
      "No se pudo contactar al servidor.",
      0,
      !navigator.onLine
    );
  }

  if (res.status === 401) throw new UnauthorizedError();

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string };
      detail = body.error ?? "";
    } catch {
      // Non-JSON error body (a Worker 1101 page, for instance) — the status is
      // all we can report.
    }
    throw new ApiError(detail || `HTTP ${res.status}`, res.status);
  }

  return (await res.json()) as T;
}

export interface ListFilters {
  status?: string;
  category?: string;
}

export async function listTasks(filters: ListFilters = {}): Promise<Task[]> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.category) params.set("category", filters.category);
  const query = params.toString();
  const body = await request<{ tasks: Task[] }>(
    `/api/tasks${query ? `?${query}` : ""}`
  );
  return body.tasks ?? [];
}

export function getTaskContext(id: string): Promise<TaskContext> {
  return request<TaskContext>(`/api/tasks/${encodeURIComponent(id)}`);
}

export function patchTask(
  id: string,
  patch: Record<string, unknown>
): Promise<{ task: Task }> {
  return request<{ task: Task }>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export interface CreateTaskPayload {
  text: string;
  device_id?: string;
  ts?: string;
  priority?: string;
  category?: string;
  parent_id?: string | null;
}

export async function createTask(
  payload: CreateTaskPayload
): Promise<{ task_id: string; task: Task }> {
  return request<{ task_id: string; task: Task }>("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: payload.text,
      device_id: payload.device_id ?? "web",
      ts: payload.ts,
      priority: payload.priority,
      category: payload.category,
      parent_id: payload.parent_id,
    }),
  });
}

export async function deleteTask(id: string): Promise<{ deleted: string }> {
  return request<{ deleted: string }>(
    `/api/tasks/${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
}

export function addDependency(
  taskId: string,
  dependsOnId: string
): Promise<{ task_id: string; depends_on_id: string; status: string }> {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/dependencies`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ depends_on_id: dependsOnId }),
  });
}

export function removeDependency(
  taskId: string,
  dependsOnId: string
): Promise<{ removed: boolean }> {
  return request(
    `/api/tasks/${encodeURIComponent(taskId)}/dependencies/${encodeURIComponent(dependsOnId)}`,
    { method: "DELETE" }
  );
}

export async function login(password: string): Promise<void> {
  await request<{ ok: boolean }>("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

export async function logout(): Promise<void> {
  try {
    await request<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
  } catch {
    // We drop to the login view regardless of what the server said.
  }
}
