// @vitest-environment jsdom
//
// The list is where the demo lands: you speak to the ESP32 and the card shows
// up here. These tests cover the two things a browser run caught that the pure
// unit tests could not — that mounting the view actually fetches, and that a
// live event paints without waiting for the network.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Task } from "../format";

const listTasks = vi.fn();

vi.mock("../api", () => ({
  listTasks: (...args: unknown[]) => listTasks(...args),
}));
vi.mock("./create", () => ({
  renderCreateForm: vi.fn(),
}));

const { renderList } = await import("./list");

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

let root: HTMLElement;
const noop = vi.fn();
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

function mount(onReady = vi.fn()) {
  return renderList(root, {}, noop, noop, noop, onReady);
}

function titles(): string[] {
  return [...root.querySelectorAll(".card__title")].map(
    (node) => node.textContent ?? ""
  );
}

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.append(root);
  listTasks.mockReset();
  listTasks.mockResolvedValue([]);
});

afterEach(() => vi.restoreAllMocks());

describe("mounting", () => {
  it("fetches and renders on mount", async () => {
    // Regression: a refactor once left the view showing its skeleton forever
    // because the initial fetch was never issued. Nothing threw; the page just
    // said "cargando…" for the rest of the session.
    listTasks.mockResolvedValue([task()]);
    mount();
    await settle();

    expect(listTasks).toHaveBeenCalledTimes(1);
    expect(titles()).toEqual(["Embalar la cocina"]);
    expect(root.querySelector(".skeleton")).toBeNull();
  });

  it("tells the shell the session is good, so the socket can open", async () => {
    const onReady = vi.fn();
    mount(onReady);
    await settle();

    expect(onReady).toHaveBeenCalled();
  });

  it("stays quiet about readiness when the session is dead", async () => {
    const error = new Error("unauthorized");
    error.name = "UnauthorizedError";
    listTasks.mockRejectedValue(error);
    const onReady = vi.fn();
    const onUnauthorized = vi.fn();
    renderList(root, {}, noop, onUnauthorized, noop, onReady);
    await settle();

    // Opening a WebSocket with no cookie only earns a 401 and a retry loop.
    expect(onReady).not.toHaveBeenCalled();
    expect(onUnauthorized).toHaveBeenCalled();
  });
});

describe("a task arriving over the socket", () => {
  it("paints the card immediately, before any refetch", async () => {
    listTasks.mockResolvedValue([task()]);
    const live = mount();
    await settle();
    listTasks.mockClear();

    live.onEvent({
      type: "task_added",
      task: task({
        id: "t-2",
        title: "Comprar leche",
        created_at: "2026-08-29T12:00:00.000Z",
      }),
    });

    // No await: the card is on screen from the broadcast payload alone.
    expect(titles()).toEqual(["Comprar leche", "Embalar la cocina"]);
    expect(listTasks).not.toHaveBeenCalled();
  });

  it("marks only the new card as live, and only once", async () => {
    listTasks.mockResolvedValue([task()]);
    const live = mount();
    await settle();

    live.onEvent({ type: "task_added", task: task({ id: "t-2", title: "Nueva" }) });
    expect(root.querySelectorAll(".card--live")).toHaveLength(1);

    // A later unrelated event must not re-flash the earlier card.
    live.onEvent({ type: "task_updated", task: task({ title: "Editada" }) });
    expect(root.querySelectorAll(".card--live")).toHaveLength(0);
  });

  it("removes a card deleted from another tab", async () => {
    listTasks.mockResolvedValue([task(), task({ id: "t-2", title: "Otra" })]);
    const live = mount();
    await settle();

    live.onEvent({ type: "task_deleted", task_id: "t-1" });

    expect(titles()).toEqual(["Otra"]);
  });

  it("keeps showing what it has when the reconcile read fails", async () => {
    listTasks.mockResolvedValue([task()]);
    const live = mount();
    await settle();
    listTasks.mockRejectedValue(new Error("network"));

    live.onResync();
    await settle();

    // Throwing away good rows over one failed background read would be worse
    // than the staleness the indicator already reports.
    expect(titles()).toEqual(["Embalar la cocina"]);
  });

  it("sends the user to login when the reconcile read is a 401", async () => {
    listTasks.mockResolvedValue([task()]);
    const onUnauthorized = vi.fn();
    const live = renderList(root, {}, noop, onUnauthorized, noop, vi.fn());
    await settle();

    const error = new Error("unauthorized");
    error.name = "UnauthorizedError";
    listTasks.mockRejectedValue(error);
    live.onResync();
    await settle();

    expect(onUnauthorized).toHaveBeenCalled();
  });
});
