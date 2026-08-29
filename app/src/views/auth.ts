// Login / logout. The browser proves identity with the HttpOnly session cookie
// from POST /api/auth/login (NID-526); no key ever reaches this code.

import { login, logout } from "../api";
import { clear, el } from "../dom";

export function renderLogin(
  root: HTMLElement,
  message: string | null,
  onSuccess: () => void
): void {
  clear(root);

  const error = el("p", { class: "banner", role: "alert" }, [message ?? ""]);
  error.hidden = !message;

  const input = el("input", {
    id: "password",
    name: "password",
    type: "password",
    autocomplete: "current-password",
    required: true,
  });

  const submit = el("button", { type: "submit", class: "btn btn--solid" }, [
    "Entrar",
  ]);

  const form = el(
    "form",
    { class: "panel login", method: "post", action: "/api/auth/login" },
    [
      el("span", { class: "panel__tag" }, ["Acceso"]),
      el("h1", { class: "title", tabindex: "-1" }, ["Timon"]),
      el("p", { class: "muted" }, [
        "Gestor de tareas por voz. El contexto completo, antes de empezar.",
      ]),
      error,
      el("div", { class: "field" }, [
        el("label", { class: "label", for: "password" }, ["Contraseña"]),
        input,
      ]),
      submit,
    ]
  );

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    const password = input.value;

    login(password)
      .then(() => {
        input.value = "";
        onSuccess();
      })
      .catch((failure: unknown) => {
        submit.disabled = false;
        const status = (failure as { status?: number }).status;
        error.textContent =
          status === 401
            ? "Contraseña incorrecta."
            : "El acceso no está disponible ahora mismo.";
        error.hidden = false;
        input.focus();
      });
  });

  root.append(form);
  input.focus();
}

export function signOut(): Promise<void> {
  return logout();
}
