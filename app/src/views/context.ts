// Context view — GET /api/tasks/:id.
//
// The TDAH core rule made real: parent above, siblings beside, subtasks below,
// blockers called out FIRST, all on one screen with no modal. The single
// "start" affordance is mounted at the end of view after every context panel
// is in the DOM.
//
// Stage 4 additions: inline edit (PATCH title/due/priority/category/parent),
// complete/undo (PATCH status), and delete (DELETE /api/tasks/:id) with
// in-page confirmation. Optimistic UI with rollback on error.

import { deleteTask, getTaskContext, patchTask } from "../api";
import { cells, clear, el, panel, strip } from "../dom";
import {
  activeBlockers,
  countLabel,
  dueLabel,
  isDone,
  priorityClass,
  priorityLabel,
  statusLabel,
  type Priority,
  type Task,
  type TaskContext,
} from "../format";
import { errorState, loadingState, notFoundState } from "./states";

function isUnauthorized(error: unknown): boolean {
  return error instanceof Error && error.name === "UnauthorizedError";
}

export function renderContext(
  root: HTMLElement,
  id: string,
  onUnauthorized: () => void
): void {
  clear(root);
  const slot = el("div", { class: "stack" }, [loadingState(2)]);
  root.append(slot);

  const load = (): void => {
    clear(slot);
    slot.append(loadingState(2));

    getTaskContext(id)
      .then((context) => {
        clear(slot);
        slot.append(view(context, load, onUnauthorized));
        const heading = slot.querySelector<HTMLElement>(".title");
        heading?.focus();
      })
      .catch((error: unknown) => {
        if (isUnauthorized(error)) {
          onUnauthorized();
          return;
        }
        clear(slot);
        const isMissing =
          typeof error === "object" &&
          error !== null &&
          (error as { status?: number }).status === 404;
        slot.append(isMissing ? notFoundState() : errorState(error, load));
      });
  };

  load();
}

function view(
  context: TaskContext,
  reload: () => void,
  onUnauthorized: () => void
): DocumentFragment {
  const { task, parent, siblings, subtasks, blockers, blocks } = context;
  const open = activeBlockers(blockers);

  const fragment = document.createDocumentFragment();

  fragment.append(crumbs(parent));

  if (blockers.length > 0) fragment.append(blockersPanel(blockers, open));

  if (parent) fragment.append(parentPanel(parent));

  const main = taskPanel(task, reload, onUnauthorized);
  fragment.append(
    el("div", { class: "context-grid" }, [
      main,
      panel(
        "Hermanas",
        siblings.length > 0
          ? [taskRows(siblings)]
          : [el("p", { class: "muted" }, ["Sin tareas hermanas."])]
      ),
    ])
  );

  fragment.append(
    panel(
      "Subtareas",
      subtasks.length > 0
        ? [
            el("p", { class: "label" }, [
              countLabel(subtasks.length, "subtarea", "subtareas"),
            ]),
            taskRows(subtasks),
          ]
        : [el("p", { class: "muted" }, ["Esta tarea no se divide en subtareas."])]
    )
  );

  if (blocks.length > 0) {
    fragment.append(
      panel("Bloquea a", [
        el("p", { class: "label" }, [
          countLabel(blocks.length, "tarea depende", "tareas dependen"),
        ]),
        taskRows(blocks),
      ])
    );
  }

  mountActions(main, task, open, reload, onUnauthorized);

  return fragment;
}

function crumbs(parent: Task | null): HTMLElement {
  const parts: (HTMLElement | string)[] = [
    el("a", { href: "/", "data-route": "" }, ["Todas las tareas"]),
  ];
  if (parent) {
    parts.push(el("span", { "aria-hidden": "true" }, ["/"]));
    parts.push(
      el(
        "a",
        { href: `/t/${encodeURIComponent(parent.id)}`, "data-route": "" },
        [parent.title]
      )
    );
  }
  return el("nav", { class: "crumbs", "aria-label": "Migas de pan" }, parts);
}

function blockersPanel(all: Task[], open: Task[]): HTMLElement {
  const body =
    open.length > 0
      ? [
          el("p", { class: "callout__label" }, [
            `Esta tarea está bloqueada por ${countLabel(open.length, "tarea", "tareas")}`,
          ]),
          taskRows(all),
        ]
      : [
          el("p", { class: "muted" }, [
            "Todas las dependencias están resueltas. Podés empezar.",
          ]),
          taskRows(all),
        ];
  return panel(
    "Bloqueada por",
    body,
    open.length > 0 ? "panel--alert" : ""
  );
}

function parentPanel(parent: Task): HTMLElement {
  return panel("Padre", [
    el(
      "a",
      {
        class: "card__title",
        href: `/t/${encodeURIComponent(parent.id)}`,
        "data-route": "",
      },
      [parent.title]
    ),
    el("ul", { class: "tags" }, tagsFor(parent)),
  ]);
}

// ── Task panel (read-only view) ────────────────────────────────────────────

function taskPanel(
  task: Task,
  reload: () => void,
  onUnauthorized: () => void
): HTMLElement {
  const due = dueLabel(task.due_date);
  const created = dueLabel(task.created_at);

  const panelEl = panel(
    "Tarea",
    [
      el("h1", { class: "title", tabindex: "-1" }, [task.title]),
      el("ul", { class: "tags" }, tagsFor(task)),
      cells([
        {
          label: "Vence",
          value: due ? due.text : "sin fecha",
          title: task.due_date ?? undefined,
        },
        { label: "Prioridad", value: priorityLabel(task.priority) },
        { label: "Categoría", value: task.category ?? "sin categoría" },
        { label: "Estado", value: statusLabel(task.status) },
        {
          label: "Creada",
          value: created ? created.text : "—",
          title: task.created_at,
        },
      ]),
      strip(),
    ],
    "panel--focus"
  );

  return panelEl;
}

function tagsFor(task: Task): HTMLElement[] {
  const due = dueLabel(task.due_date);
  const done = isDone(task);
  const tags: HTMLElement[] = [];
  if (due) {
    tags.push(
      el(
        "li",
        { class: `tag ${due.overdue && !done ? "tag--overdue" : "tag--due"}` },
        [`${due.relative} · ${due.absolute}`]
      )
    );
  }
  tags.push(
    el("li", { class: `tag ${priorityClass(task.priority)}` }, [
      priorityLabel(task.priority),
    ])
  );
  if (task.category) tags.push(el("li", { class: "tag" }, [task.category]));
  tags.push(el("li", { class: "tag" }, [statusLabel(task.status)]));
  return tags;
}

function taskRows(tasks: Task[]): HTMLElement {
  return el(
    "ul",
    { class: "rows" },
    tasks.map((task) => {
      const due = dueLabel(task.due_date);
      const done = isDone(task);
      return el("li", {}, [
        el(
          "a",
          {
            class: "row",
            href: `/t/${encodeURIComponent(task.id)}`,
            "data-route": "",
          },
          [
            el("span", { class: done ? "row__done" : null }, [
              task.title,
              done
                ? el("span", { class: "visually-hidden" }, [
                    ` — ${statusLabel(task.status)}`,
                  ])
                : null,
            ]),
            el("span", { class: "value" }, [
              due ? due.relative : priorityLabel(task.priority),
            ]),
          ]
        ),
      ]);
    })
  );
}

// ── Actions (start / edit / complete / undo / delete) ──────────────────────

function mountActions(
  main: HTMLElement,
  task: Task,
  openBlockers: Task[],
  reload: () => void,
  onUnauthorized: () => void
): void {
  const actionsEl = el("div", { class: "actions" }, []);

  // 1. Start button (existing)
  if (task.status === "pending") {
    const blocked = openBlockers.length > 0;
    const status = el("p", { class: "label", role: "status" }, []);
    const button = el(
      "button",
      {
        type: "button",
        class: blocked ? "btn" : "btn btn--solid",
      },
      [blocked ? "Empezar igual" : "Empezar"]
    );
    if (blocked) {
      status.textContent = `${countLabel(openBlockers.length, "bloqueo", "bloqueos")} sin resolver`;
    }
    button.addEventListener("click", () => {
      button.disabled = true;
      status.textContent = "marcando…";
      patchTask(task.id, { status: "in_progress" })
        .then(() => reload())
        .catch((error: unknown) => {
          if (isUnauthorized(error)) {
            onUnauthorized();
            return;
          }
          button.disabled = false;
          status.textContent = "no se pudo marcar — reintentá";
        });
    });
    actionsEl.append(el("div", { class: "actions__row" }, [button, status]));
  }

  // 2. In-progress indicator
  if (task.status === "in_progress") {
    actionsEl.append(
      el("div", { class: "actions__row" }, [
        el("p", { class: "label" }, ["esta tarea ya está en curso"]),
      ])
    );
  }

  // 3. Complete / undo
  if (task.status === "in_progress") {
    const undoStatus = el("p", { class: "label", role: "status" }, []);
    const completeBtn = el(
      "button",
      { type: "button", class: "btn btn--solid" },
      ["Marcar hecha"]
    );
    completeBtn.addEventListener("click", () => {
      completeBtn.disabled = true;
      undoStatus.textContent = "marcando…";
      patchTask(task.id, { status: "done" })
        .then(() => reload())
        .catch((error: unknown) => {
          if (isUnauthorized(error)) {
            onUnauthorized();
            return;
          }
          completeBtn.disabled = false;
          undoStatus.textContent = "no se pudo marcar — reintentá";
        });
    });
    actionsEl.append(
      el("div", { class: "actions__row" }, [completeBtn, undoStatus])
    );
  }

  // 4. Undo (re-open) for done/cancelled tasks
  if (isDone(task)) {
    const undoStatus = el("p", { class: "label", role: "status" }, []);
    const undoBtn = el(
      "button",
      { type: "button", class: "btn" },
      ["Reabrir"]
    );
    undoBtn.addEventListener("click", () => {
      undoBtn.disabled = true;
      undoStatus.textContent = "reabriendo…";
      patchTask(task.id, { status: "pending" })
        .then(() => reload())
        .catch((error: unknown) => {
          if (isUnauthorized(error)) {
            onUnauthorized();
            return;
          }
          undoBtn.disabled = false;
          undoStatus.textContent = "no se pudo reabrir — reintentá";
        });
    });
    actionsEl.append(
      el("div", { class: "actions__row" }, [undoBtn, undoStatus])
    );
  }

  // 5. Edit button
  if (!isDone(task)) {
    const editBtn = el(
      "button",
      { type: "button", class: "btn" },
      ["Editar"]
    );
    editBtn.addEventListener("click", () => {
      mountEditForm(main, task, reload, onUnauthorized);
    });
    actionsEl.append(el("div", { class: "actions__row" }, [editBtn]));
  }

  // 6. Delete button (with in-page confirmation)
  const deleteSlot = el("div", { class: "actions__row" });
  mountDeleteButton(deleteSlot, task, reload, onUnauthorized);
  actionsEl.append(deleteSlot);

  main.append(actionsEl);
}

// ── Inline edit form ───────────────────────────────────────────────────────

function mountEditForm(
  main: HTMLElement,
  task: Task,
  reload: () => void,
  onUnauthorized: () => void
): void {
  // Remove the read-only cells and actions, replace with edit form
  const cellsEl = main.querySelector(".cells");
  const actionsEl = main.querySelector(".actions");
  const tagsEl = main.querySelector(".tags");
  const titleEl = main.querySelector(".title");

  // Hide read-only elements
  if (cellsEl) (cellsEl as HTMLElement).hidden = true;
  if (actionsEl) (actionsEl as HTMLElement).hidden = true;
  if (tagsEl) (tagsEl as HTMLElement).hidden = true;

  // Replace title with input
  if (titleEl) {
    const titleInput = el("input", {
      type: "text",
      class: "title-input",
      value: task.title,
      "aria-label": "Título",
    }) as HTMLInputElement;
    titleEl.replaceWith(titleInput);
    titleInput.focus();
    titleInput.select();
  }

  const statusEl = el("p", { class: "label", role: "status" }, []);

  const prioritySelect = el(
    "select",
    { id: "edit-priority", name: "priority" },
    [
      el("option", { value: "", selected: !task.priority }, ["sin prioridad"]),
      el("option", { value: "high", selected: task.priority === "high" }, [
        "alta",
      ]),
      el("option", { value: "medium", selected: task.priority === "medium" }, [
        "media",
      ]),
      el("option", { value: "low", selected: task.priority === "low" }, [
        "baja",
      ]),
    ]
  ) as HTMLSelectElement;

  const categoryInput = el("input", {
    type: "text",
    id: "edit-category",
    name: "category",
    value: task.category ?? "",
    placeholder: "categoría",
  }) as HTMLInputElement;

  const dueInput = el("input", {
    type: "date",
    id: "edit-due",
    name: "due_date",
    value: task.due_date ? task.due_date.slice(0, 10) : "",
  }) as HTMLInputElement;

  const saveBtn = el(
    "button",
    { type: "button", class: "btn btn--solid" },
    ["Guardar"]
  );
  const cancelBtn = el(
    "button",
    { type: "button", class: "btn" },
    ["Cancelar"]
  );

  const editForm = el("div", { class: "edit-form" }, [
    el("div", { class: "field-group" }, [
      el("div", { class: "field" }, [
        el("label", { class: "label", for: "edit-priority" }, ["Prioridad"]),
        prioritySelect,
      ]),
      el("div", { class: "field" }, [
        el("label", { class: "label", for: "edit-category" }, ["Categoría"]),
        categoryInput,
      ]),
      el("div", { class: "field" }, [
        el("label", { class: "label", for: "edit-due" }, ["Vence"]),
        dueInput,
      ]),
    ]),
    el("div", { class: "actions" }, [saveBtn, cancelBtn, statusEl]),
  ]);

  // Insert edit form after the strip (before actions)
  const stripEl = main.querySelector(".strip");
  if (stripEl) {
    stripEl.after(editForm);
  } else {
    main.append(editForm);
  }

  const cancelEdit = (): void => {
    editForm.remove();
    // Restore read-only view
    reload();
  };

  cancelBtn.addEventListener("click", cancelEdit);

  saveBtn.addEventListener("click", () => {
    const titleInput = main.querySelector<HTMLInputElement>(".title-input");
    const newTitle = titleInput?.value.trim() ?? task.title;
    if (!newTitle) {
      statusEl.textContent = "el título no puede estar vacío";
      titleInput?.focus();
      return;
    }

    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    statusEl.textContent = "guardando…";

    const patch: Record<string, unknown> = {};
    if (newTitle !== task.title) patch.title = newTitle;
    if (prioritySelect.value !== (task.priority ?? ""))
      patch.priority = prioritySelect.value || null;
    if (categoryInput.value.trim() !== (task.category ?? ""))
      patch.category = categoryInput.value.trim() || null;
    if (dueInput.value !== (task.due_date ? task.due_date.slice(0, 10) : "")) {
      patch.due_date = dueInput.value
        ? new Date(dueInput.value + "T23:59:59").toISOString()
        : null;
    }

    if (Object.keys(patch).length === 0) {
      cancelEdit();
      return;
    }

    patchTask(task.id, patch)
      .then(() => reload())
      .catch((error: unknown) => {
        if (isUnauthorized(error)) {
          onUnauthorized();
          return;
        }
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
        const msg =
          error instanceof Error ? error.message : "no se pudo guardar";
        statusEl.textContent = msg;
      });
  });
}

// ── Delete with in-page confirmation ───────────────────────────────────────

function mountDeleteButton(
  slot: HTMLElement,
  task: Task,
  reload: () => void,
  onUnauthorized: () => void
): void {
  const statusEl = el("p", { class: "label", role: "status" }, []);
  const deleteBtn = el(
    "button",
    { type: "button", class: "btn btn--danger" },
    ["Eliminar"]
  );

  deleteBtn.addEventListener("click", () => {
    // Replace with confirmation UI
    slot.replaceChildren();
    const confirmBtn = el(
      "button",
      { type: "button", class: "btn btn--danger" },
      ["Confirmar eliminación"]
    );
    const cancelBtn = el(
      "button",
      { type: "button", class: "btn" },
      ["Cancelar"]
    );
    slot.append(confirmBtn, cancelBtn, statusEl);
    statusEl.textContent = "¿Segura? Esta acción no se puede deshacer.";

    cancelBtn.addEventListener("click", () => {
      reload();
    });

    confirmBtn.addEventListener("click", () => {
      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      statusEl.textContent = "eliminando…";
      deleteTask(task.id)
        .then(() => {
          // Navigate back to the list after deletion
          history.pushState({}, "", "/");
          window.dispatchEvent(new PopStateEvent("popstate"));
        })
        .catch((error: unknown) => {
          if (isUnauthorized(error)) {
            onUnauthorized();
            return;
          }
          confirmBtn.disabled = false;
          cancelBtn.disabled = false;
          const msg =
            error instanceof Error ? error.message : "no se pudo eliminar";
          statusEl.textContent = msg;
        });
    });
  });

  slot.append(deleteBtn, statusEl);
}
