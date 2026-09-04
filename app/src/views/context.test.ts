// @vitest-environment jsdom
//
// The context view is the app's only write path. These tests exist because a
// review found that its 401 handling was missing and no test could have caught
// it: `renderList`/`renderContext` route an expired session to the login
// screen, but the start button used to swallow the same error and tell the
// user to retry — forever.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Task, TaskContext } from "../format";

const getTaskContext = vi.fn();
const patchTask = vi.fn();

vi.mock("../api", () => ({
  getTaskContext: (...args: unknown[]) => getTaskContext(...args),
  patchTask: (...args: unknown[]) => patchTask(...args),
}));

const { renderContext } = await import("./context");

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t-1",
    title: "Embalar la cocina",
    parent_id: null,
    due_date: null,
    priority: "high",
    category: "casa",
    status: "pending",
    completed_at: null,
    created_at: "2026-08-28T12:00:00.000Z",
    updated_at: "2026-08-28T12:00:00.000Z",
    ...overrides,
  };
}

function context(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    task: task(),
    parent: null,
    siblings: [],
    subtasks: [],
    blockers: [],
    blocks: [],
    ...overrides,
  };
}

function unauthorized(): Error {
  const error = new Error("unauthorized");
  error.name = "UnauthorizedError";
  return error;
}

let root: HTMLElement;
const onNavigate = vi.fn();

/** Let the view's promise chain settle. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.append(root);
  getTaskContext.mockReset();
  patchTask.mockReset();
  onNavigate.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe("renderContext — the start affordance", () => {
  it("routes an expired session to login instead of asking for a retry", async () => {
    getTaskContext.mockResolvedValue(context());
    patchTask.mockRejectedValue(unauthorized());
    const onUnauthorized = vi.fn();

    renderContext(root, "t-1", onUnauthorized, onNavigate, vi.fn());
    await settle();

    const button = root.querySelector<HTMLButtonElement>(".actions button");
    expect(button?.textContent).toBe("Empezar");
    button?.click();
    await settle();

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(root.textContent).not.toContain("reintentá");
  });

  it("still offers a retry for an ordinary server failure", async () => {
    getTaskContext.mockResolvedValue(context());
    patchTask.mockRejectedValue(new Error("boom"));
    const onUnauthorized = vi.fn();

    renderContext(root, "t-1", onUnauthorized, onNavigate, vi.fn());
    await settle();

    const button = root.querySelector<HTMLButtonElement>(".actions button");
    button?.click();
    await settle();

    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(root.textContent).toContain("reintentá");
    expect(button?.disabled).toBe(false);
  });

  it("marks the task in progress on a successful start", async () => {
    getTaskContext.mockResolvedValue(context());
    patchTask.mockResolvedValue({ task: task({ status: "in_progress" }) });

    renderContext(root, "t-1", vi.fn(), onNavigate, vi.fn());
    await settle();
    root.querySelector<HTMLButtonElement>(".actions button")?.click();
    await settle();

    expect(patchTask).toHaveBeenCalledWith("t-1", { status: "in_progress" });
  });

  it("drops to a wireframe and names the open blockers when blocked", async () => {
    getTaskContext.mockResolvedValue(
      context({
        blockers: [task({ id: "b-1", title: "Comprar cajas", status: "pending" })],
      })
    );

    renderContext(root, "t-1", vi.fn(), onNavigate, vi.fn());
    await settle();

    const button = root.querySelector<HTMLButtonElement>(".actions button");
    expect(button?.textContent).toBe("Empezar igual");
    expect(button?.className).toBe("btn"); // not btn--solid: fill = primacy
    expect(root.textContent).toContain("1 bloqueo sin resolver");
  });

  it("treats a resolved dependency as not blocking", async () => {
    getTaskContext.mockResolvedValue(
      context({
        blockers: [task({ id: "b-1", title: "Comprar cajas", status: "done" })],
      })
    );

    renderContext(root, "t-1", vi.fn(), onNavigate, vi.fn());
    await settle();

    const button = root.querySelector<HTMLButtonElement>(".actions button");
    expect(button?.textContent).toBe("Empezar");
    expect(root.textContent).toContain("Todas las dependencias están resueltas");
  });

  it("offers no start button for a task that is already done, but offers reopen", async () => {
    getTaskContext.mockResolvedValue({
      ...context(),
      task: task({ status: "done" }),
    });

    renderContext(root, "t-1", vi.fn(), onNavigate, vi.fn());
    await settle();

    // No "Empezar" button, but there is a "Reabrir" button
    const buttons = root.querySelectorAll<HTMLButtonElement>(".actions button");
    const startBtn = [...buttons].find((b) => b.textContent === "Empezar");
    const reopenBtn = [...buttons].find((b) => b.textContent === "Reabrir");
    expect(startBtn).toBeUndefined();
    expect(reopenBtn).toBeDefined();
    // Status shows "hecha" (the done label)
    expect(root.textContent).toContain("hecha");
  });
});

describe("renderContext — context before action", () => {
  it("puts blockers first, parent above, siblings beside, subtasks below", async () => {
    getTaskContext.mockResolvedValue(
      context({
        task: task({ parent_id: "p-1" }),
        parent: task({ id: "p-1", title: "Mudanza" }),
        siblings: [task({ id: "s-1", title: "Contratar el flete" })],
        subtasks: [task({ id: "c-1", title: "Vaciar la alacena" })],
        blockers: [task({ id: "b-1", title: "Comprar cajas" })],
      })
    );

    renderContext(root, "t-1", vi.fn(), onNavigate, vi.fn());
    await settle();

    const panels = [...root.querySelectorAll(".panel__tag")].map(
      (n) => n.textContent
    );
    expect(panels).toEqual([
      "Bloqueada por",
      "Padre",
      "Tarea",
      "Hermanas",
      "Subtareas",
    ]);
  });

  it("announces a resolved sibling's status, not just a strike-through", async () => {
    getTaskContext.mockResolvedValue(
      context({
        task: task({ parent_id: "p-1" }),
        parent: task({ id: "p-1", title: "Mudanza" }),
        siblings: [
          task({ id: "s-1", title: "Dar de baja internet", status: "done" }),
        ],
      })
    );

    renderContext(root, "t-1", vi.fn(), onNavigate, vi.fn());
    await settle();

    const row = root.querySelector(".row__done");
    expect(row?.querySelector(".visually-hidden")?.textContent).toBe(" — hecha");
  });

  it("renders a task title as text, never as markup", async () => {
    getTaskContext.mockResolvedValue(
      context({ task: task({ title: "<img src=x onerror=alert(1)>" }) })
    );

    renderContext(root, "t-1", vi.fn(), onNavigate, vi.fn());
    await settle();

    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector(".title")?.textContent).toBe(
      "<img src=x onerror=alert(1)>"
    );
  });

  it("shows a real 404 state for a task that does not exist", async () => {
    const missing = Object.assign(new Error("task_not_found"), { status: 404 });
    getTaskContext.mockRejectedValue(missing);

    renderContext(root, "t-1", vi.fn(), onNavigate, vi.fn());
    await settle();

    expect(root.textContent).toContain("Esa tarea no existe");
  });

  it("routes a 401 on the initial read to login", async () => {
    getTaskContext.mockRejectedValue(unauthorized());
    const onUnauthorized = vi.fn();

    renderContext(root, "t-1", onUnauthorized, onNavigate, vi.fn());
    await settle();

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
