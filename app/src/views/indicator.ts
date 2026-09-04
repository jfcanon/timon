// The live/reconnecting readout in the masthead.
//
// Deliberately quiet: one dot and one word, `role="status"` with a polite live
// region so a screen reader mentions a lost connection once, after whatever
// the user was already being told. A task manager for a distractible brain
// should not shout about its own plumbing.

import { el } from "../dom";
import type { LiveStatus } from "../live";

export interface LiveIndicator {
  readonly node: HTMLElement;
  set: (status: LiveStatus) => void;
}

const LABEL: Record<LiveStatus, string> = {
  live: "en vivo",
  reconnecting: "reconectando…",
};

export function createLiveIndicator(): LiveIndicator {
  const dot = el("span", { class: "live__dot", "aria-hidden": "true" });
  const text = el("span", {}, [LABEL.reconnecting]);
  const node = el(
    "p",
    {
      class: "live live--reconnecting",
      role: "status",
      "aria-live": "polite",
    },
    [dot, text]
  );

  return {
    node,
    set(status: LiveStatus): void {
      node.className = `live live--${status}`;
      text.textContent = LABEL[status];
    },
  };
}
