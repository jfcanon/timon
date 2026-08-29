// Presentation helpers. Pure functions, no DOM — unit-tested in format.test.ts.

export type Priority = "high" | "medium" | "low";

export interface Task {
  id: string;
  title: string;
  parent_id: string | null;
  due_date: string | null;
  priority: Priority | string | null;
  category: string | null;
  status: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  /** Present on list rows only (see decorateTasks in src/lib/store.js). */
  parent_title?: string | null;
  subtask_count?: number;
  blocked_by_count?: number;
  blocked_by?: { id: string; title: string; status: string | null }[];
}

export interface TaskContext {
  task: Task;
  parent: Task | null;
  siblings: Task[];
  subtasks: Task[];
  blockers: Task[];
  blocks: Task[];
}

const MS_PER_DAY = 86_400_000;

const PRIORITY_LABEL: Record<string, string> = {
  high: "alta",
  medium: "media",
  low: "baja",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "pendiente",
  in_progress: "en curso",
  done: "hecha",
  cancelled: "cancelada",
};

export function priorityLabel(priority: string | null | undefined): string {
  return PRIORITY_LABEL[priority ?? ""] ?? "sin prioridad";
}

export function priorityClass(priority: string | null | undefined): string {
  return priority === "high" || priority === "medium" || priority === "low"
    ? `tag--prio-${priority}`
    : "tag--prio-low";
}

export function statusLabel(status: string | null | undefined): string {
  return STATUS_LABEL[status ?? ""] ?? "pendiente";
}

export function isDone(task: Pick<Task, "status">): boolean {
  return task.status === "done" || task.status === "cancelled";
}

/** Whole-day difference between two instants, counted in local calendar days. */
export function dayDelta(due: Date, now: Date): number {
  const a = Date.UTC(due.getFullYear(), due.getMonth(), due.getDate());
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a - b) / MS_PER_DAY);
}

export function relativeDay(delta: number): string {
  if (delta === 0) return "hoy";
  if (delta === 1) return "mañana";
  if (delta === -1) return "ayer";
  if (delta > 0) {
    if (delta < 30) return `en ${delta} días`;
    const months = Math.round(delta / 30);
    return months === 1 ? "en 1 mes" : `en ${months} meses`;
  }
  const past = Math.abs(delta);
  if (past < 30) return `hace ${past} días`;
  const months = Math.round(past / 30);
  return months === 1 ? "hace 1 mes" : `hace ${months} meses`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `2026-08-30`, plus ` 14:30` when the due date carries a real time of day. */
export function absoluteDay(due: Date): string {
  const date = `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}`;
  if (due.getHours() === 0 && due.getMinutes() === 0) return date;
  return `${date} ${pad(due.getHours())}:${pad(due.getMinutes())}`;
}

export interface DueLabel {
  /** "mañana · 2026-08-30" — relative first, absolute always visible. */
  text: string;
  relative: string;
  absolute: string;
  overdue: boolean;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse a stored due date the way a person means it.
 *
 * `new Date()` is not consistent here: per spec a date-only string
 * ("2026-09-05") is parsed as **UTC** midnight, while a datetime string is
 * parsed as local time. In Buenos Aires (UTC-3) that renders a date-only due
 * date as the PREVIOUS day at 21:00 and flips "hoy" into "ayer". A date-only
 * value is a calendar day with no time, so it is built in local time here.
 */
export function parseDue(iso: string): Date | null {
  const dateOnly = DATE_ONLY.exec(iso);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]) - 1;
    const day = Number(dateOnly[3]);
    const local = new Date(year, month, day);
    // `new Date(2026, 12, 99)` silently rolls over into April 2027 rather than
    // failing, so a garbage date would render as a plausible wrong one.
    if (
      local.getFullYear() !== year ||
      local.getMonth() !== month ||
      local.getDate() !== day
    ) {
      return null;
    }
    return local;
  }
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function dueLabel(
  iso: string | null | undefined,
  now: Date = new Date()
): DueLabel | null {
  if (!iso) return null;
  const due = parseDue(iso);
  if (!due) return null;
  const delta = dayDelta(due, now);
  const relative = relativeDay(delta);
  const absolute = absoluteDay(due);
  return {
    text: `${relative} · ${absolute}`,
    relative,
    absolute,
    overdue: delta < 0,
  };
}

export function countLabel(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

/** Blockers that still block: a done or cancelled dependency is not a blocker. */
export function activeBlockers<T extends { status: string | null }>(
  blockers: T[] | undefined
): T[] {
  return (blockers ?? []).filter((b) => !isDone(b));
}
