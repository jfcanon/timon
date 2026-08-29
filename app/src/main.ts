// Timon web app — shell, router and session gate (NID-527).
//
// Two routes, both server-safe: `/` (list) and `/t/:id` (context). The Worker
// serves the shell for any non-/api path (`not_found_handling =
// single-page-application`), so a deep link into a task survives a refresh.
//
// List filters live in the query string, not in a module variable: that is what
// makes a filtered list shareable, survive a refresh, undo with Back, and reset
// when you click "Tareas".

import "./styles.css";
import { clear, el } from "./dom";
import { renderContext } from "./views/context";
import { renderList } from "./views/list";
import { renderLogin, signOut } from "./views/auth";
import { offlineBanner } from "./views/states";
import { contextIdFromPath, filtersFromSearch, listHref } from "./routing";

const page = document.getElementById("page") as HTMLElement;
const main = document.getElementById("main") as HTMLElement;
const mastheadSlot = document.getElementById("masthead") as HTMLElement;
const bannerSlot = document.getElementById("banner") as HTMLElement;

/** Where to return to once a login succeeds. */
let pendingReturnTo: string | null = null;

function currentHref(): string {
  return location.pathname + location.search;
}

// Push only when the URL actually changes — but always re-render. Returning
// early on an unchanged href would make "Aplicar" with the same filters, and
// "Tareas" from an already-unfiltered list, silently do nothing.
function navigate(href: string): void {
  if (href !== currentHref()) history.pushState({}, "", href);
  route();
}

function showLogin(message: string | null = null): void {
  // Remember where the user was so a session that dies on /t/:id does not
  // silently demote them to the list after they log back in.
  pendingReturnTo = currentHref();
  clear(mastheadSlot);
  renderLogin(main, message, () => {
    const returnTo = pendingReturnTo ?? "/";
    pendingReturnTo = null;
    history.replaceState({}, "", returnTo);
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
    void signOut().then(() => {
      history.replaceState({}, "", "/");
      showLogin();
    });
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
    filtersFromSearch(location.search),
    (next) => navigate(listHref(next)),
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
