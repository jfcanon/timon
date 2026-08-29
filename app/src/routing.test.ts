import { describe, it, expect } from "vitest";
import {
  contextIdFromPath,
  filtersFromSearch,
  listHref,
  searchFromFilters,
} from "./routing";

describe("contextIdFromPath", () => {
  it("reads the id out of a task path", () => {
    expect(contextIdFromPath("/t/abc-123")).toBe("abc-123");
  });

  it("decodes an escaped id", () => {
    expect(contextIdFromPath("/t/a%20b")).toBe("a b");
  });

  it("is null for the list route and anything else", () => {
    expect(contextIdFromPath("/")).toBeNull();
    expect(contextIdFromPath("/tasks")).toBeNull();
  });

  // Regression: an unguarded decodeURIComponent threw URIError here, and since
  // the Worker serves the shell for any non-/api path that left a blank page
  // with no way back.
  it("survives a malformed escape instead of throwing", () => {
    expect(() => contextIdFromPath("/t/abc%")).not.toThrow();
    expect(contextIdFromPath("/t/abc%")).toBe("abc%");
  });
});

describe("filters <-> query string", () => {
  it("reads filters out of the URL", () => {
    expect(filtersFromSearch("?status=done&category=casa")).toEqual({
      status: "done",
      category: "casa",
    });
  });

  it("treats absent and empty as no filter", () => {
    expect(filtersFromSearch("")).toEqual({
      status: undefined,
      category: undefined,
    });
    expect(filtersFromSearch("?status=&category=")).toEqual({
      status: undefined,
      category: undefined,
    });
  });

  it("round-trips", () => {
    const filters = { status: "in_progress", category: "trabajo" };
    expect(filtersFromSearch(searchFromFilters(filters))).toEqual(filters);
  });

  it("encodes a category with a space", () => {
    expect(searchFromFilters({ category: "obra social" })).toBe(
      "?category=obra+social"
    );
    expect(filtersFromSearch("?category=obra+social").category).toBe(
      "obra social"
    );
  });

  // Regression: filters used to live in a module variable, so the masthead
  // "Tareas" link (href="/") equalled the current URL even with a filter
  // applied and the router's identity check made the click a no-op.
  it("gives a filtered list a href that differs from the reset link", () => {
    expect(listHref({ status: "done" })).toBe("/?status=done");
    expect(listHref({})).toBe("/");
    expect(listHref({ status: "done" })).not.toBe("/");
  });
});
