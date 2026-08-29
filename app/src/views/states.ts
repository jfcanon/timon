// Empty, error, offline and loading are designed states, not blank screens.

import { ApiError } from "../api";
import { el, panel } from "../dom";

function state(
  tag: string,
  title: string,
  body: string,
  action?: HTMLElement
): HTMLElement {
  return panel(
    tag,
    [
      el("h2", { class: "state__title" }, [title]),
      el("p", { class: "state__body" }, [body]),
      action,
    ],
    "state"
  );
}

export function loadingState(rows = 3): HTMLElement {
  const skeletons = Array.from({ length: rows }, () =>
    el("div", { class: "skeleton", "aria-hidden": "true" })
  );
  return panel(
    "Cargando",
    [
      el("p", { class: "visually-hidden" }, ["Cargando tareas…"]),
      el("div", { class: "stack stack--tight" }, skeletons),
    ],
    "state"
  );
}

export function emptyState(filtered: boolean, onReset?: () => void): HTMLElement {
  if (filtered) {
    const button = el("button", { type: "button", class: "btn" }, [
      "Quitar filtros",
    ]);
    if (onReset) button.addEventListener("click", onReset);
    return state(
      "Sin resultados",
      "Nada con esos filtros",
      "Ninguna tarea coincide con el estado o la categoría elegidos. Probá quitando un filtro.",
      button
    );
  }
  return state(
    "Vacío",
    "Todavía no hay tareas",
    "Decile algo al ESP32 o creá una tarea desde la API y va a aparecer acá. Timon te muestra el contexto completo antes de que empieces."
  );
}

export function errorState(error: unknown, onRetry: () => void): HTMLElement {
  const button = el("button", { type: "button", class: "btn btn--solid" }, [
    "Reintentar",
  ]);
  button.addEventListener("click", onRetry);

  if (error instanceof ApiError && error.offline) return offlineState(onRetry);

  const detail =
    error instanceof ApiError
      ? error.status > 0
        ? `El servidor respondió ${error.status}.`
        : "No hubo respuesta del servidor."
      : "Error inesperado.";

  return state(
    "Error",
    "No se pudieron cargar los datos",
    `${detail} Nada se perdió: volvé a intentar en un momento.`,
    button
  );
}

export function offlineState(onRetry: () => void): HTMLElement {
  const button = el("button", { type: "button", class: "btn" }, [
    "Reintentar",
  ]);
  button.addEventListener("click", onRetry);
  return state(
    "Sin conexión",
    "Estás sin conexión",
    "Timon lee y escribe contra el Worker, así que necesita red. Reconectate y volvé a intentar.",
    button
  );
}

export function notFoundState(): HTMLElement {
  const link = el("a", { class: "btn", href: "/", "data-route": "" }, [
    "Volver a la lista",
  ]);
  return state(
    "404",
    "Esa tarea no existe",
    "Puede que la hayas borrado o que el enlace esté viejo.",
    link
  );
}

/** A persistent strip shown while the browser reports no connectivity. */
export function offlineBanner(): HTMLElement {
  return el("p", { class: "banner", role: "status" }, [
    "Sin conexión — mostrando lo último que se cargó",
  ]);
}
