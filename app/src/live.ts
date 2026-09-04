import type { Task } from "./format";

export type LiveStatus = "live" | "reconnecting" | "offline";

export type LiveEvent =
  | { type: "task_added"; task: Task }
  | { type: "task_updated"; task: Task }
  | { type: "task_deleted"; task: Task };

export interface LiveFilters {
  status?: string;
  category?: string;
}

type StatusListener = (status: LiveStatus) => void;
type ViewHandler = (event: LiveEvent) => void;

const MAX_DELAY_MS = 15_000;

let socket: WebSocket | null = null;
let attempts = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let stopped = true;
let status: LiveStatus = "offline";
let viewHandler: ViewHandler | null = null;
const statusListeners = new Set<StatusListener>();

export function liveUrl(
  loc: { protocol: string; host: string } = location
): string {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}/api/ws`;
}

export function reconnectDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, MAX_DELAY_MS);
}

export function prefersReducedMotion(
  media: { matches: boolean } | null = null
): boolean {
  if (media) return media.matches;
  if (typeof matchMedia !== "function") return false;
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function matchesFilters(task: Task, filters: LiveFilters): boolean {
  if (filters.status && task.status !== filters.status) return false;
  if (filters.category && task.category !== filters.category) return false;
  return true;
}

export function applyLiveTasks(
  tasks: Task[],
  filters: LiveFilters,
  event: LiveEvent
): { tasks: Task[]; enteredId: string | null } {
  if (event.type === "task_deleted") {
    const id = event.task?.id;
    if (!id) return { tasks, enteredId: null };
    return { tasks: tasks.filter((t) => t.id !== id), enteredId: null };
  }

  const task = event.task;
  if (!task?.id) return { tasks, enteredId: null };

  if (event.type === "task_added") {
    if (!matchesFilters(task, filters)) {
      return { tasks: tasks.filter((t) => t.id !== task.id), enteredId: null };
    }
    if (tasks.some((t) => t.id === task.id)) {
      return {
        tasks: tasks.map((t) => (t.id === task.id ? task : t)),
        enteredId: null,
      };
    }
    return { tasks: [task, ...tasks], enteredId: task.id };
  }

  if (!matchesFilters(task, filters)) {
    return { tasks: tasks.filter((t) => t.id !== task.id), enteredId: null };
  }
  const idx = tasks.findIndex((t) => t.id === task.id);
  if (idx >= 0) {
    const next = tasks.slice();
    next[idx] = task;
    return { tasks: next, enteredId: null };
  }
  return { tasks: [task, ...tasks], enteredId: task.id };
}

export function getLiveStatus(): LiveStatus {
  return status;
}

export function subscribeStatus(listener: StatusListener): () => void {
  statusListeners.add(listener);
  listener(status);
  return () => {
    statusListeners.delete(listener);
  };
}

export function attachLiveView(handler: ViewHandler): void {
  viewHandler = handler;
}

export function detachLiveView(): void {
  viewHandler = null;
}

function setStatus(next: LiveStatus): void {
  if (status === next) return;
  status = next;
  for (const listener of statusListeners) listener(next);
}

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function handleMessage(raw: string): void {
  let data: { type?: string; task?: Task };
  try {
    data = JSON.parse(raw) as { type?: string; task?: Task };
  } catch {
    return;
  }
  if (
    data.type === "task_added" ||
    data.type === "task_updated" ||
    data.type === "task_deleted"
  ) {
    if (data.task && viewHandler) {
      viewHandler({ type: data.type, task: data.task });
    }
  }
}

function connect(): void {
  if (stopped) return;
  clearTimer();
  try {
    socket = new WebSocket(liveUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  socket.addEventListener("open", () => {
    attempts = 0;
    setStatus("live");
    try {
      socket?.send(JSON.stringify({ type: "subscribe" }));
    } catch {
      // subscribe is optional; broadcasts still arrive
    }
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") handleMessage(event.data);
  });
  socket.addEventListener("close", () => {
    socket = null;
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    socket?.close();
  });
}

function scheduleReconnect(): void {
  if (stopped) {
    setStatus("offline");
    return;
  }
  setStatus("reconnecting");
  clearTimer();
  const delay = reconnectDelay(attempts);
  attempts += 1;
  timer = setTimeout(() => {
    timer = null;
    connect();
  }, delay);
}

export function startLive(): void {
  if (started) return;
  started = true;
  stopped = false;
  attempts = 0;
  connect();
}

export function stopLive(): void {
  started = false;
  stopped = true;
  clearTimer();
  const current = socket;
  socket = null;
  if (current) {
    current.onclose = null;
    current.close();
  }
  setStatus("offline");
}
