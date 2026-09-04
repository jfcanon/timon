// The list card: everything you need to decide, without opening anything.

import { el, strip } from "../dom";
import {
  activeBlockers,
  countLabel,
  dueLabel,
  isDone,
  priorityClass,
  priorityLabel,
  statusLabel,
  type Task,
} from "../format";

export interface CardOptions {
  /** Suppress the breadcrumb when the card is already nested under its parent. */
  showCrumb: boolean;
  /** Mark a card that just arrived over the live socket (NID-529). */
  live?: boolean;
}

export function taskCard(task: Task, options: CardOptions): HTMLElement {
  const due = dueLabel(task.due_date);
  const blockers = activeBlockers(task.blocked_by);
  const done = isDone(task);

  const tags: HTMLElement[] = [];

  if (due) {
    tags.push(
      el(
        "li",
        {
          class: `tag ${due.overdue && !done ? "tag--overdue" : "tag--due"}`,
          title: due.absolute,
        },
        [`${due.relative} · ${due.absolute}`]
      )
    );
  }

  tags.push(
    el("li", { class: `tag ${priorityClass(task.priority)}` }, [
      priorityLabel(task.priority),
    ])
  );

  if (task.category) {
    tags.push(el("li", { class: "tag" }, [task.category]));
  }

  if (task.status && task.status !== "pending") {
    tags.push(el("li", { class: "tag" }, [statusLabel(task.status)]));
  }

  if (task.subtask_count) {
    tags.push(
      el("li", { class: "tag" }, [
        countLabel(task.subtask_count, "subtarea", "subtareas"),
      ])
    );
  }

  const children: (HTMLElement | null)[] = [];

  if (options.showCrumb && task.parent_id) {
    children.push(
      el(
        "a",
        {
          class: "card__crumb",
          href: `/t/${encodeURIComponent(task.parent_id)}`,
          "data-route": "",
        },
        [el("span", { "aria-hidden": "true" }, ["↖"]), task.parent_title ?? "tarea padre"]
      )
    );
  }

  children.push(
    el(
      "a",
      {
        class: "card__title",
        href: `/t/${encodeURIComponent(task.id)}`,
        "data-route": "",
      },
      [task.title]
    )
  );

  if (blockers.length > 0) {
    children.push(blockedCallout(blockers));
  }

  children.push(el("ul", { class: "tags" }, tags));
  children.push(strip());

  return el(
    "article",
    {
      class: `card${done ? " card__done" : ""}${options.live ? " card--live" : ""}`,
    },
    children
  );
}

function blockedCallout(
  blockers: { id: string; title: string }[]
): HTMLElement {
  const parts: (HTMLElement | string)[] = [
    el("span", { class: "callout__label" }, ["Bloqueada por:"]),
  ];
  blockers.forEach((blocker, index) => {
    if (index > 0) parts.push(", ");
    parts.push(
      el(
        "a",
        { href: `/t/${encodeURIComponent(blocker.id)}`, "data-route": "" },
        [blocker.title]
      )
    );
  });
  return el("p", { class: "callout" }, parts);
}
