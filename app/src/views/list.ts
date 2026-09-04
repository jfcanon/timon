// List view — GET /api/tasks.
//
// Cards carry the whole decision: title, relative + absolute due date, priority
// badge, category chip, inline parent breadcrumb, a "blocked by" callout naming
// the blockers, and subtasks nested one level under their parent.
//
// Stage 4: the list view includes the create form at the top so users can
// add tasks directly from the browser.

import { listTasks, type ListFilters } from "../api";
import { clear, el } from "../dom";
import { countLabel, type Task } from "../format";
import {
  applyLiveTasks,
  attachLiveView,
  prefersReducedMotion,
} from "../live";
import { buildTree, type TreeNode } from "../tree";
import { renderCreateForm } from "./create";
import { taskCard } from "./card";
import { emptyState, errorState, loadingState } from "./states";

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
  enteredId: string | null
): HTMLElement {
  return el(
    "ol",
    { class: `tasks${nested ? " tasks--nested" : ""}` },
    nodes.map((node) =>
      el("li", {}, [
        taskCard(node.task, {
          showCrumb: !nested,
          entering: Boolean(enteredId && node.task.id === enteredId),
        }),
        node.children.length > 0
          ? renderTree(node.children, true, enteredId)
          : null,
      ])
    )
  );
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
  onNavigate: (href: string) => void
): void {
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

  let tasks: Task[] = [];

  const paint = (enteredId: string | null): void => {
    readout.textContent = countLabel(tasks.length, "tarea", "tareas");
    clear(results);
    if (tasks.length === 0) {
      const isFiltered = Boolean(filters.status || filters.category);
      results.append(
        emptyState(isFiltered, isFiltered ? () => onFilter({}) : undefined)
      );
      return;
    }
    const mark =
      enteredId && !prefersReducedMotion() ? enteredId : null;
    results.append(renderTree(buildTree(tasks), false, mark));
  };

  const load = (): void => {
    clear(results);
    results.append(loadingState());
    readout.textContent = "cargando…";

    listTasks(filters)
      .then((rows) => {
        tasks = rows;
        clear(filterSlot);
        filterSlot.append(
          filterForm(filters, categoriesOf(tasks), onFilter)
        );

        clear(createSlot);
        renderCreateForm(createSlot, {
          categories: categoriesOf(tasks),
          onCreated: (taskId) => {
            onNavigate(`/t/${taskId}`);
          },
          onUnauthorized,
        });

        paint(null);
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

  attachLiveView((event) => {
    const next = applyLiveTasks(tasks, filters, event);
    tasks = next.tasks;
    paint(next.enteredId);
  });

  load();
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
