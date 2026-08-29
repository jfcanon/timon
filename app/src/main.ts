// Timon web app — shell, router and session gate (NID-527).
//
// Two routes, both server-safe: `/` (list) and `/t/:id` (context). The Worker
// serves the shell for any non-/api path (`not_found_handling =
// single-page-application`), so a deep link into a task survives a refresh.

import "./styles.css";
import { clear, el } from "./dom";
import { renderContext } from "./views/context";
import { renderList } from "./views/list";
import { renderLogin, signOut } from "./views/auth";
import { offlineBanner } from "./views/states";
import type { ListFilters } from "./api";

const page = document.getElementById("page") as HTMLElement;
const main = document.getElementById("main") as HTMLElement;
const mastheadSlot = document.getElementById("masthead") as HTMLElement;
const bannerSlot = document.getElementById("banner") as HTMLElement;

let filters: ListFilters = {};

function contextIdFromPath(pathname: string): string | null {
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

function navigate(href: string): void {
  if (href === location.pathname + location.search) return;
  history.pushState({}, "", href);
  route();
}

function showLogin(message: string | null = null): void {
  clear(mastheadSlot);
  renderLogin(main, message, () => {
    history.replaceState({}, "", "/");
    filters = {};
    route();
  });
}

function masthead(): void {
  clear(mastheadSlot);

  const logoutButton = el("button", { type: "button", class: "btn btn--quiet" }, [
    "Salir",
  ]);
  logoutButton.addEventListener("click", () => {
    logoutButton.disabled = true;
    void signOut().then(() => showLogin());
  });

  mastheadSlot.append(
    el("header", { class: "masthead" }, [
      el("p", { class: "wordmark" }, ["Timon"]),
      el("div", { class: "masthead__meta" }, [
        el("a", { class: "btn btn--quiet", href: "/", "data-route": "" }, [
          "Tareas",
        ]),
        logoutButton,
      ]),
    ])
  );
}

function route(): void {
  masthead();
  const id = contextIdFromPath(location.pathname);
  if (id) {
    renderContext(main, id, () => showLogin("Tu sesión expiró."));
    return;
  }
  renderList(
    main,
    filters,
    (next) => {
      filters = next;
      route();
    },
    () => showLogin("Tu sesión expiró.")
  );
}

// Intercept in-app links so the views never trigger a full reload.
page.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>(
    "a[data-route]"
  );
  if (!target) return;
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(target.getAttribute("href") ?? "/");
});

window.addEventListener("popstate", () => route());

function syncConnectivity(): void {
  clear(bannerSlot);
  if (!navigator.onLine) bannerSlot.append(offlineBanner());
}

window.addEventListener("online", () => {
  syncConnectivity();
  route();
});
window.addEventListener("offline", syncConnectivity);

// No separate session probe: both views already fetch the gated API and both
// route a 401 to the login screen. Probing first would double every page load
// and, on a large list, double the work the Worker does to answer it.
function start(): void {
  syncConnectivity();
  route();
}

start();
