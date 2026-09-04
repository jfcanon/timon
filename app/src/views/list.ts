// List view — GET /api/tasks.
//
// Cards carry the whole decision: title, relative + absolute due date, priority
// badge, category chip, inline parent breadcrumb, a "blocked by" callout naming
// the blockers, and subtasks nested one level under their parent.
//
// Stage 4: the list view includes the create form at the top so users can
// add tasks directly from the browser.

import { listTasks, type ListFilters } from "../api";
import { debounce } from "../debounce";
import { clear, el } from "../dom";
import { countLabel, type Task } from "../format";
import { applyEvent } from "../list-state";
import type { LiveSink } from "../live";
import { buildTree, type TreeNode } from "../tree";
import { renderCreateForm } from "./create";
import { taskCard } from "./card";
import { emptyState, errorState, loadingState } from "./states";

/** Wait out a burst of related broadcasts before re-reading the list. */
const RECONCILE_MS = 400;

const STATUS_OPTIONS: [string, string][] = [
  ["", "todos"],
  ["pending", "pendiente"],
  ["in_progress", "en curso"],
  ["done", "hecha"],
  ["cancelled", "cancelada"],
];

function renderTree(
  nodes: TreeNode[],
  nested: boolean,
  liveIds: ReadonlySet<string>
): HTMLElement {
  return el(
    "ol",
    { class: `tasks${nested ? " tasks--nested" : ""}` },
    nodes.map((node) =>
      el("li", {}, [
        taskCard(node.task, {
          showCrumb: !nested,
          live: liveIds.has(node.task.id),
        }),
        node.children.length > 0
          ? renderTree(node.children, true, liveIds)
          : null,
      ])
    )
  );
}

/**
 * Re-rendering the results container drops whatever link inside it had focus.
 * Re-focusing the same href afterwards keeps keyboard navigation from being
 * thrown back to the top of the page every time the ESP32 speaks.
 */
function keepFocus(container: HTMLElement, render: () => void): void {
  const active = document.activeElement;
  const href =
    active instanceof HTMLAnchorElement && container.contains(active)
      ? active.getAttribute("href")
      : null;
  render();
  if (!href) return;
  container
    .querySelector<HTMLAnchorElement>(`a[href="${CSS.escape(href)}"]`)
    ?.focus();
}

// Categories are only discoverable from the rows we have. Remembering the ones
// seen so far keeps the picker usable after a filter returns nothing — without
// it, choosing a status with no matches would empty the category list too.
const knownCategories = new Set<string>();

function categoriesOf(tasks: Task[]): string[] {
  for (const task of tasks) if (task.category) knownCategories.add(task.category);
  return [...knownCategories].sort();
}

export function renderList(
  root: HTMLElement,
  filters: ListFilters,
  onFilter: (next: ListFilters) => void,
  onUnauthorized: () => void,
  onNavigate: (href: string) => void,
  onReady: () => void
): LiveSink {
  clear(root);

  const heading = el("h1", { class: "visually-hidden", tabindex: "-1" }, [
    "Tareas",
  ]);
  const readout = el("p", { class: "label", role: "status" }, ["cargando…"]);
  const results = el("div", { class: "stack stack--tight" }, [loadingState()]);

  // Categories are only known once a response arrives, so the filter form is
  // built after the fetch and swapped in here.
  const filterSlot = el("div", { class: "stack stack--tight" });

  // Create form slot — shown after loading, populated with known categories.
  const createSlot = el("div", { class: "stack stack--tight" });

  root.append(heading, filterSlot, createSlot, readout, results);

  // The rows currently on screen. Live events edit a copy of this and re-render
  // from it, so a card can appear without a round-trip.
  let tasks: readonly Task[] = [];
  // Ids to highlight on the next paint, cleared once painted so the highlight
  // does not come back on every later re-render.
  let liveIds = new Set<string>();

  const paint = (): void => {
    keepFocus(results, () => {
      readout.textContent = countLabel(tasks.length, "tarea", "tareas");
      clear(results);
      if (tasks.length === 0) {
        const isFiltered = Boolean(filters.status || filters.category);
        results.append(
          emptyState(isFiltered, isFiltered ? () => onFilter({}) : undefined)
        );
      } else {
        results.append(renderTree(buildTree([...tasks]), false, liveIds));
      }
    });
    liveIds = new Set();
  };

  const load = (): void => {
    clear(results);
    results.append(loadingState());
    readout.textContent = "cargando…";

    listTasks(filters)
      .then((fetched) => {
        tasks = fetched;
        clear(filterSlot);
        filterSlot.append(
          filterForm(filters, categoriesOf(fetched), onFilter)
        );

        // Render create form with known categories
        clear(createSlot);
        renderCreateForm(createSlot, {
          categories: categoriesOf(fetched),
          onCreated: (taskId) => {
            // Navigate to the newly created task's context view
            onNavigate(`/t/${taskId}`);
          },
          onUnauthorized,
        });

        paint();
        // The session is good, so the shell can open the live socket. Opening
        // it before this point just earns a 401 on every logged-out page load.
        onReady();
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "UnauthorizedError") {
          onUnauthorized();
          return;
        }
        readout.textContent = "sin datos";
        clear(results);
        results.append(errorState(error, load));
      });
  };

  /**
   * Re-read the list after a live edit. The broadcast carries the changed row
   * in full, but not the DECORATION a sibling row picked up as a side effect —
   * a new subtask bumps its parent's `subtask_count`, and the parent's own
   * broadcast may describe a row this filter excludes. One quiet request
   * settles all of it.
   *
   * Quiet on purpose: no skeleton, and the filter and create forms are left
   * alone. Rebuilding them here would reset a half-typed new task or a
   * dropdown the user just opened.
   */
  const reconcile = (): void => {
    listTasks(filters)
      .then((fetched) => {
        tasks = fetched;
        categoriesOf(fetched);
        paint();
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "UnauthorizedError") {
          onUnauthorized();
          return;
        }
        // The rows already on screen came from the same API and are still the
        // best answer we have; replacing them with an error panel would throw
        // away good data over one failed background read. The masthead
        // indicator is what tells the user the connection is unhappy.
        readout.textContent = `${countLabel(tasks.length, "tarea", "tareas")} · sin actualizar`;
      });
  };

  const reconcileSoon = debounce(reconcile, RECONCILE_MS);

  load();

  return {
    onEvent(event) {
      const next = applyEvent(tasks, event, filters);
      if (event.type === "task_added" && event.task) {
        liveIds = new Set([event.task.id]);
      }
      tasks = next;
      paint();
      reconcileSoon();
    },
    onResync() {
      reconcileSoon.cancel();
      reconcile();
    },
  };
}

function filterForm(
  filters: ListFilters,
  categories: string[],
  onFilter: (next: ListFilters) => void
): HTMLElement {
  const statusSelect = el(
    "select",
    { id: "filter-status", name: "status" },
    STATUS_OPTIONS.map(([value, label]) =>
      el(
        "option",
        { value, selected: (filters.status ?? "") === value },
        [label]
      )
    )
  );

  const categorySelect = el(
    "select",
    { id: "filter-category", name: "category" },
    [
      el(
        "option",
        { value: "", selected: !filters.category },
        ["todas"]
      ),
      ...categories.map((category) =>
        el(
          "option",
          { value: category, selected: filters.category === category },
          [category]
        )
      ),
    ]
  );

  const form = el("form", { class: "panel filters" }, [
    el("span", { class: "panel__tag" }, ["Filtros"]),
    el("div", { class: "field" }, [
      el("label", { class: "label", for: "filter-status" }, ["Estado"]),
      statusSelect,
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "label", for: "filter-category" }, ["Categoría"]),
      categorySelect,
    ]),
    el("button", { type: "submit", class: "btn btn--solid" }, ["Aplicar"]),
  ]);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    onFilter({
      status: statusSelect.value || undefined,
      category: categorySelect.value || undefined,
    });
  });

  return form;
}
