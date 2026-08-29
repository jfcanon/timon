import { describe, it, expect } from "vitest";
import {
  absoluteDay,
  activeBlockers,
  countLabel,
  dayDelta,
  dueLabel,
  isDone,
  parseDue,
  priorityClass,
  priorityLabel,
  relativeDay,
  statusLabel,
} from "./format";

const NOW = new Date(2026, 7, 29, 10, 0, 0); // 2026-08-29 local

describe("dayDelta", () => {
  it("counts calendar days, not 24h blocks", () => {
    // 23:00 today → 01:00 tomorrow is 2h apart but one calendar day.
    expect(dayDelta(new Date(2026, 7, 30, 1, 0), new Date(2026, 7, 29, 23, 0))).toBe(1);
  });

  it("is zero for the same day", () => {
    expect(dayDelta(new Date(2026, 7, 29, 23, 59), NOW)).toBe(0);
  });

  it("crosses a month boundary", () => {
    expect(dayDelta(new Date(2026, 8, 1, 9, 0), NOW)).toBe(3);
  });
});

describe("relativeDay", () => {
  it("names the near days", () => {
    expect(relativeDay(0)).toBe("hoy");
    expect(relativeDay(1)).toBe("mañana");
    expect(relativeDay(-1)).toBe("ayer");
  });

  it("counts days out to a month, then months", () => {
    expect(relativeDay(4)).toBe("en 4 días");
    expect(relativeDay(-4)).toBe("hace 4 días");
    expect(relativeDay(30)).toBe("en 1 mes");
    expect(relativeDay(90)).toBe("en 3 meses");
    expect(relativeDay(-60)).toBe("hace 2 meses");
  });
});

describe("absoluteDay", () => {
  it("is date-only at midnight", () => {
    expect(absoluteDay(new Date(2026, 7, 30, 0, 0))).toBe("2026-08-30");
  });

  it("adds the time when the due date carries one", () => {
    expect(absoluteDay(new Date(2026, 7, 30, 14, 30))).toBe("2026-08-30 14:30");
  });

  it("zero-pads month, day, hour and minute", () => {
    expect(absoluteDay(new Date(2026, 0, 5, 9, 7))).toBe("2026-01-05 09:07");
  });
});

describe("dueLabel", () => {
  it("renders relative + absolute together", () => {
    const label = dueLabel("2026-08-30T00:00:00", NOW);
    expect(label?.text).toBe("mañana · 2026-08-30");
    expect(label?.overdue).toBe(false);
  });

  it("flags a past due date as overdue", () => {
    const label = dueLabel("2026-08-27T00:00:00", NOW);
    expect(label?.relative).toBe("hace 2 días");
    expect(label?.overdue).toBe(true);
  });

  it("is null for a missing or unparseable date", () => {
    expect(dueLabel(null, NOW)).toBeNull();
    expect(dueLabel("", NOW)).toBeNull();
    expect(dueLabel("not a date", NOW)).toBeNull();
  });

  it("does not treat today as overdue", () => {
    expect(dueLabel("2026-08-29T08:00:00", NOW)?.overdue).toBe(false);
  });
});

describe("parseDue", () => {
  // Regression: `new Date("2026-09-05")` is UTC midnight, which in Buenos Aires
  // (UTC-3) is 2026-09-04 21:00 local — the wrong day, with a spurious time.
  it("reads a date-only value as a LOCAL calendar day", () => {
    const due = parseDue("2026-09-05");
    expect(due?.getFullYear()).toBe(2026);
    expect(due?.getMonth()).toBe(8);
    expect(due?.getDate()).toBe(5);
    expect(due?.getHours()).toBe(0);
    expect(absoluteDay(due as Date)).toBe("2026-09-05");
  });

  it("does not shift a date-only due date across the day boundary", () => {
    const label = dueLabel("2026-08-30", NOW);
    expect(label?.text).toBe("mañana · 2026-08-30");
    expect(label?.overdue).toBe(false);
  });

  it("still marks today's date-only value as due today, not overdue", () => {
    const label = dueLabel("2026-08-29", NOW);
    expect(label?.relative).toBe("hoy");
    expect(label?.overdue).toBe(false);
  });

  it("leaves a full datetime alone", () => {
    const due = parseDue("2026-09-05T14:30:00");
    expect(due?.getHours()).toBe(14);
    expect(due?.getMinutes()).toBe(30);
  });

  it("is null for an unparseable value", () => {
    expect(parseDue("not a date")).toBeNull();
    expect(parseDue("2026-13-99")).toBeNull();
  });
});

describe("labels", () => {
  it("translates priority and status", () => {
    expect(priorityLabel("high")).toBe("alta");
    expect(priorityLabel(null)).toBe("sin prioridad");
    expect(statusLabel("in_progress")).toBe("en curso");
    expect(statusLabel(null)).toBe("pendiente");
  });

  it("maps priority to a fill class, never a second hue", () => {
    expect(priorityClass("high")).toBe("tag--prio-high");
    expect(priorityClass("nonsense")).toBe("tag--prio-low");
  });

  it("pluralises counts", () => {
    expect(countLabel(1, "tarea", "tareas")).toBe("1 tarea");
    expect(countLabel(0, "tarea", "tareas")).toBe("0 tareas");
  });
});

describe("activeBlockers", () => {
  it("drops resolved dependencies — a done blocker does not block", () => {
    const blockers = [
      { id: "a", title: "A", status: "pending" },
      { id: "b", title: "B", status: "done" },
      { id: "c", title: "C", status: "cancelled" },
    ];
    expect(activeBlockers(blockers).map((b) => b.id)).toEqual(["a"]);
  });

  it("handles a missing blocked_by field", () => {
    expect(activeBlockers(undefined)).toEqual([]);
  });
});

describe("isDone", () => {
  it("treats done and cancelled as finished", () => {
    expect(isDone({ status: "done" })).toBe(true);
    expect(isDone({ status: "cancelled" })).toBe(true);
    expect(isDone({ status: "in_progress" })).toBe(false);
  });
});
