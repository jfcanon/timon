// Tiny DOM builder. Everything the views render goes through `el` and text
// nodes, never innerHTML — task titles and categories are user/voice input and
// must never be parsed as markup.

type Attrs = Record<string, string | number | boolean | null | undefined>;
type Child = Node | string | number | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Child[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (value === true) {
      node.setAttribute(key, "");
      continue;
    }
    node.setAttribute(key, String(value));
  }
  node.append(...toNodes(children));
  return node;
}

export function frag(children: Child[]): DocumentFragment {
  const f = document.createDocumentFragment();
  f.append(...toNodes(children));
  return f;
}

function toNodes(children: Child[]): (Node | string)[] {
  const out: (Node | string)[] = [];
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    out.push(typeof child === "number" ? String(child) : child);
  }
  return out;
}

export function clear(node: Element): void {
  node.replaceChildren();
}

// A panel whose tag label straddles its own top border (Phase 5 structure).
export function panel(
  tag: string,
  children: Child[],
  className = ""
): HTMLElement {
  return el("section", { class: `panel ${className}`.trim() }, [
    el("span", { class: "panel__tag" }, [tag]),
    ...children,
  ]);
}

// Label / value cell list.
export function cells(
  rows: { label: string; value: string; title?: string }[]
): HTMLElement {
  return el(
    "dl",
    { class: "cells" },
    rows.map((row) =>
      el("div", {}, [
        el("dt", {}, [row.label]),
        el("dd", { title: row.title ?? null }, [row.value]),
      ])
    )
  );
}

// Decorative marked strip along the bottom of a record.
export function strip(): HTMLElement {
  return el("div", { class: "strip", "aria-hidden": "true" });
}
