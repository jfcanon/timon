// URL <-> view-state mapping, kept out of main.ts so it is testable without
// booting the shell.
//
// Filters live in the query string on purpose: that is what makes a filtered
// list shareable, survive a refresh, undo with Back, and reset when the
// masthead "Tareas" link is clicked.

import type { ListFilters } from "./api";

export function contextIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/t\/(.+)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    // A truncated or malformed escape (/t/abc%) throws URIError. The shell is
    // served for any non-/api path, so an unguarded throw here would leave the
    // page blank with no way back. Pass the raw segment through instead and
    // let the API answer 404, which the view already renders as a real state.
    return match[1];
  }
}

export function filtersFromSearch(search: string): ListFilters {
  const params = new URLSearchParams(search);
  const status = params.get("status") ?? "";
  const category = params.get("category") ?? "";
  return {
    status: status || undefined,
    category: category || undefined,
  };
}

export function searchFromFilters(filters: ListFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.category) params.set("category", filters.category);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function listHref(filters: ListFilters): string {
  return `/${searchFromFilters(filters)}`;
}
