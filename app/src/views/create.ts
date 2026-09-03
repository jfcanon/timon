// Create task form — POST /api/tasks.
//
// Real <form> and <button> controls, no inline scripts. The title text goes
// through the same extractIntent path as voice; the optional fields (priority,
// category, due, parent) are sent as explicit contract values that override
// the LLM's extraction (owner decision, NID-470).

import { createTask } from "../api";
import { el } from "../dom";

const PRIORITY_OPTIONS: [string, string][] = [
  ["", "sin prioridad"],
  ["high", "alta"],
  ["medium", "media"],
  ["low", "baja"],
];

interface CreateFormOptions {
  parentId?: string | null;
  categories?: string[];
  onCreated: (taskId: string) => void;
  onUnauthorized: () => void;
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof Error && error.name === "UnauthorizedError";
}

export function renderCreateForm(
  root: HTMLElement,
  options: CreateFormOptions
): void {
  const {
    parentId = null,
    categories = [],
    onCreated,
    onUnauthorized,
  } = options;

  const form = buildForm(parentId, categories, onCreated, onUnauthorized);
  root.append(form);
}

function buildForm(
  parentId: string | null,
  categories: string[],
  onCreated: (taskId: string) => void,
  onUnauthorized: () => void
): HTMLElement {
  const statusEl = el("p", { class: "label", role: "status" }, []);

  const titleInput = el("input", {
    type: "text",
    id: "create-title",
    name: "text",
    required: "",
    placeholder: "Escribí lo que necesitás…",
    autocomplete: "off",
  }) as HTMLInputElement;

  const prioritySelect = el(
    "select",
    { id: "create-priority", name: "priority" },
    PRIORITY_OPTIONS.map(([value, label]) =>
      el("option", { value }, [label])
    )
  ) as HTMLSelectElement;

  const categoryInput = el("input", {
    type: "text",
    id: "create-category",
    name: "category",
    placeholder: "ej: trabajo, casa",
    list: "category-list",
  }) as HTMLInputElement;

  const categoryDatalist = el(
    "datalist",
    { id: "category-list" },
    categories.map((cat) => el("option", { value: cat }))
  );

  const dueInput = el("input", {
    type: "date",
    id: "create-due",
    name: "due_date",
  }) as HTMLInputElement;

  const parentInput = el("input", {
    type: "hidden",
    name: "parent_id",
    value: parentId ?? "",
  });

  const submitBtn = el(
    "button",
    { type: "submit", class: "btn btn--solid" },
    ["Crear tarea"]
  );

  const form = el("form", { class: "panel create-form" }, [
    el("span", { class: "panel__tag" }, ["Nueva tarea"]),
    el("div", { class: "field" }, [
      el("label", { class: "label", for: "create-title" }, ["Título"]),
      titleInput,
    ]),
    el("div", { class: "field-group" }, [
      el("div", { class: "field" }, [
        el("label", { class: "label", for: "create-priority" }, ["Prioridad"]),
        prioritySelect,
      ]),
      el("div", { class: "field" }, [
        el("label", { class: "label", for: "create-category" }, ["Categoría"]),
        categoryInput,
        categoryDatalist,
      ]),
      el("div", { class: "field" }, [
        el("label", { class: "label", for: "create-due" }, ["Vence"]),
        dueInput,
      ]),
    ]),
    parentInput,
    el("div", { class: "actions" }, [submitBtn, statusEl]),
  ]);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const title = titleInput.value.trim();
    if (!title) {
      statusEl.textContent = "escribí un título";
      titleInput.focus();
      return;
    }

    submitBtn.disabled = true;
    statusEl.textContent = "creando…";

    const payload: {
      text: string;
      device_id: string;
      priority?: string;
      category?: string;
      parent_id?: string | null;
      ts?: string;
    } = {
      text: title,
      device_id: "web",
    };

    if (prioritySelect.value) payload.priority = prioritySelect.value;
    if (categoryInput.value.trim()) payload.category = categoryInput.value.trim();
    if (dueInput.value) {
      // Convert date-only to ISO datetime at end of day in local time
      // (new Date("2026-09-05T23:59:59") parses as local, but
      //  new Date("2026-09-05T23:59:59") string-concatenated still triggers
      //  the same UTC shift when read back via slice — use local components)
      const [year, month, day] = dueInput.value.split("-").map(Number);
      const date = new Date(year, month - 1, day, 23, 59, 59);
      payload.ts = date.toISOString();
    }
    if (parentId) payload.parent_id = parentId;

    createTask(payload)
      .then((result) => {
        statusEl.textContent = "tarea creada";
        titleInput.value = "";
        prioritySelect.value = "";
        categoryInput.value = "";
        dueInput.value = "";
        submitBtn.disabled = false;
        onCreated(result.task_id);
      })
      .catch((error: unknown) => {
        if (isUnauthorized(error)) {
          onUnauthorized();
          return;
        }
        submitBtn.disabled = false;
        const msg =
          error instanceof Error ? error.message : "no se pudo crear";
        statusEl.textContent = msg;
      });
  });

  return form;
}
