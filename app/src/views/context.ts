// Context view — GET /api/tasks/:id.
//
// The TDAH core rule made real: parent above, siblings beside, subtasks below,
// blockers called out FIRST, all on one screen with no modal. The single
// "start" affordance is appended only after every context panel is in the DOM
// (see `mountStart` at the bottom) — you cannot start before you have seen
// what you are starting.

import { getTaskContext, patchTask } from "../api";
import { cells, clear, el, panel, strip } from "../dom";
import {
  activeBlockers,
  countLabel,
  dueLabel,
  isDone,
  priorityClass,
  priorityLabel,
  statusLabel,
  type Task,
  type TaskContext,
} from "../format";
import { errorState, loadingState, notFoundState } from "./states";

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
        slot.append(view(context, load));
        const heading = slot.querySelector<HTMLElement>(".title");
        heading?.focus();
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "UnauthorizedError") {
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

function view(context: TaskContext, reload: () => void): DocumentFragment {
  const { task, parent, siblings, subtasks, blockers, blocks } = context;
  const open = activeBlockers(blockers);

  const fragment = document.createDocumentFragment();

  fragment.append(crumbs(parent));

  // 1. Blockers first — they are the reason not to start.
  if (blockers.length > 0) fragment.append(blockersPanel(blockers, open));

  // 2. Parent above.
  if (parent) fragment.append(parentPanel(parent));

  // 3. The task itself, with siblings beside it on desktop.
  const main = taskPanel(task);
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

  // 4. Subtasks below.
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

  // 5. Only now — with parent, siblings, subtasks and blockers on screen — the
  //    start affordance is mounted into the task panel.
  mountStart(main, task, open, reload);

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

function taskPanel(task: Task): HTMLElement {
  const due = dueLabel(task.due_date);
  const created = dueLabel(task.created_at);

  return panel(
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
      return el("li", {}, [
        el(
          "a",
          {
            class: "row",
            href: `/t/${encodeURIComponent(task.id)}`,
            "data-route": "",
          },
          [
            el("span", { class: isDone(task) ? "row__done" : null }, [
              task.title,
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

/**
 * The single start affordance. It is created here, at the end of the render,
 * rather than inside `taskPanel`, so that it is impossible to ship a version
 * where the button paints before the context does.
 */
function mountStart(
  main: HTMLElement,
  task: Task,
  openBlockers: Task[],
  reload: () => void
): void {
  const status = el("p", { class: "label", role: "status" }, []);

  if (task.status === "in_progress") {
    status.textContent = "esta tarea ya está en curso";
    main.append(el("div", { class: "actions" }, [status]));
    return;
  }

  if (isDone(task)) {
    status.textContent = `tarea ${statusLabel(task.status)}`;
    main.append(el("div", { class: "actions" }, [status]));
    return;
  }

  const blocked = openBlockers.length > 0;
  const button = el(
    "button",
    {
      type: "button",
      // Fill = primacy. A blocked task's start button drops to a wireframe so
      // the solid element on screen is never the one you should not press.
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
      .catch(() => {
        button.disabled = false;
        status.textContent = "no se pudo marcar — reintentá";
      });
  });

  main.append(el("div", { class: "actions" }, [button, status]));
}
