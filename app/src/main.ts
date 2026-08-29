// Timon app — browser auth flow (NID-526)
//
// The browser has no Bearer key. It proves identity with an HttpOnly session
// cookie obtained from POST /api/auth/login. Every fetch to the gated API goes
// with `credentials: "same-origin"` so the cookie rides along; a 401 means the
// session is missing/expired and we drop back to the login view.

const loginView = document.getElementById("login-view") as HTMLElement;
const appView = document.getElementById("app-view") as HTMLElement;
const loginForm = document.getElementById("login-form") as HTMLFormElement;
const loginError = document.getElementById("login-error") as HTMLElement;
const passwordInput = document.getElementById("password") as HTMLInputElement;
const logoutButton = document.getElementById("logout-button") as HTMLButtonElement;

function showLogin(message?: string): void {
  appView.hidden = true;
  loginView.hidden = false;
  if (message) {
    loginError.textContent = message;
    loginError.hidden = false;
  } else {
    loginError.hidden = true;
    loginError.textContent = "";
  }
  passwordInput.focus();
}

function showApp(): void {
  loginView.hidden = true;
  loginError.hidden = true;
  appView.hidden = false;
}

// Probe the gated API with the session cookie. Only an explicit 200 means we
// hold a valid session; anything else (401, 404, network error) means we must
// show the login view.
async function checkAuth(): Promise<boolean> {
  const res = await fetch("/api/tasks", {
    method: "GET",
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  return res.status === 200;
}

loginForm.addEventListener("submit", async (event: SubmitEvent) => {
  event.preventDefault();
  const password = passwordInput.value;
  loginError.hidden = true;

  let res: Response;
  try {
    res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ password }),
    });
  } catch {
    showLogin("Network error. Please try again.");
    return;
  }

  if (res.status === 200) {
    passwordInput.value = "";
    showApp();
  } else if (res.status === 401) {
    showLogin("Incorrect password.");
  } else {
    showLogin("Sign-in is unavailable right now.");
  }
});

logoutButton.addEventListener("click", async () => {
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
  } catch {
    // Swallow — we redirect to login regardless.
  }
  showLogin();
});

async function init(): Promise<void> {
  let authed = false;
  try {
    authed = await checkAuth();
  } catch {
    authed = false;
  }
  if (authed) {
    showApp();
  } else {
    showLogin();
  }
}

void init();
