import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  verifyApiKey,
  verifySessionCookie,
  isAuthorized,
  createSessionToken,
  sessionCookieValue,
  clearedSessionCookieValue,
  SESSION_COOKIE,
  timingSafeEqual,
} from "../src/lib/auth.js";

function makeEnv(overrides = {}) {
  return {
    TIMON_API_KEY: "test-api-key-123",
    APP_PASSWORD: "test-app-password",
    SESSION_SECRET: "test-session-secret-32-bytes-long!!",
    TIMON_META: {
      prepare: vi.fn(() => ({
        run: vi.fn(async () => {}),
        all: vi.fn(async () => ({ results: [] })),
        bind: vi.fn(() => ({
          run: vi.fn(async () => {}),
          first: vi.fn(async () => null),
          all: vi.fn(async () => ({ results: [] })),
        })),
      })),
    },
    SESSION: {
      idFromName: vi.fn(() => "mock-id"),
      get: vi.fn(() => ({
        addTask: vi.fn(async () => ({})),
        updateTask: vi.fn(async () => ({})),
        removeTask: vi.fn(async () => ({})),
      })),
    },
    ...overrides,
  };
}

describe("verifyApiKey", () => {
  it("returns false with no Authorization header", () => {
    const req = new Request("https://x/api/tasks", { method: "GET" });
    expect(verifyApiKey(req, makeEnv())).toBe(false);
  });

  it("returns false with a non-Bearer scheme", () => {
    const req = new Request("https://x/api/tasks", {
      method: "GET",
      headers: { authorization: "Basic abc" },
    });
    expect(verifyApiKey(req, makeEnv())).toBe(false);
  });

  it("returns false with the wrong key", () => {
    const req = new Request("https://x/api/tasks", {
      method: "GET",
      headers: { authorization: "Bearer wrong" },
    });
    expect(verifyApiKey(req, makeEnv())).toBe(false);
  });

  it("returns true with the correct Bearer key", () => {
    const req = new Request("https://x/api/tasks", {
      method: "GET",
      headers: { authorization: "Bearer test-api-key-123" },
    });
    expect(verifyApiKey(req, makeEnv())).toBe(true);
  });
});

describe("verifySessionCookie", () => {
  it("returns false when no cookie is present", async () => {
    const req = new Request("https://x/api/tasks", { method: "GET" });
    expect(await verifySessionCookie(req, makeEnv())).toBe(false);
  });

  it("returns false when SESSION_SECRET is absent", async () => {
    const env = makeEnv({ SESSION_SECRET: undefined });
    const req = new Request("https://x/api/tasks", {
      method: "GET",
      headers: { cookie: `${SESSION_COOKIE}=some.token.value` },
    });
    expect(await verifySessionCookie(req, env)).toBe(false);
  });

  it("returns true for a valid, unexpired session cookie", async () => {
    const env = makeEnv();
    const token = await createSessionToken(env, "owner");
    const req = new Request("https://x/api/tasks", {
      method: "GET",
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(await verifySessionCookie(req, env)).toBe(true);
  });

  it("returns false for a tampered signature", async () => {
    const env = makeEnv();
    const token = await createSessionToken(env, "owner");
    const [payload] = token.split(".");
    const tampered = `${payload}.AAAA`;
    const req = new Request("https://x/api/tasks", {
      method: "GET",
      headers: { cookie: `${SESSION_COOKIE}=${tampered}` },
    });
    expect(await verifySessionCookie(req, env)).toBe(false);
  });

  it("returns false for an expired session", async () => {
    const env = makeEnv();
    // Build a token that expired 10s ago by forging the payload directly.
    const expiredPayload = Buffer.from(
      JSON.stringify({ sub: "owner", exp: Math.floor(Date.now() / 1000) - 10 })
    ).toString("base64url");
    // Re-sign with the real secret via createSessionToken path is awkward; instead
    // craft a token using the same HMAC by calling createSessionToken then
    // swapping payload — simpler to test the exp check through a custom token.
    const sig = await (async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(env.SESSION_SECRET),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const s = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(expiredPayload));
      let bin = "";
      new Uint8Array(s).forEach((b) => (bin += String.fromCharCode(b)));
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    })();
    const token = `${expiredPayload}.${sig}`;
    const req = new Request("https://x/api/tasks", {
      method: "GET",
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(await verifySessionCookie(req, env)).toBe(false);
  });
});

describe("isAuthorized", () => {
  it("returns false for an anonymous request", async () => {
    const req = new Request("https://x/api/tasks", { method: "GET" });
    expect(await isAuthorized(req, makeEnv())).toBe(false);
  });

  it("returns true for a Bearer request", async () => {
    const req = new Request("https://x/api/tasks", {
      method: "GET",
      headers: { authorization: "Bearer test-api-key-123" },
    });
    expect(await isAuthorized(req, makeEnv())).toBe(true);
  });

  it("returns true for a cookie request", async () => {
    const env = makeEnv();
    const token = await createSessionToken(env, "owner");
    const req = new Request("https://x/api/tasks", {
      method: "GET",
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(await isAuthorized(req, env)).toBe(true);
  });

  it("is exported (NID-529 will call it for the WS upgrade)", () => {
    expect(typeof isAuthorized).toBe("function");
  });
});

describe("POST /api/auth/login", () => {
  let worker;
  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../src/index.js");
    worker = mod.default;
  });

  it("returns 401 on a wrong password", async () => {
    const env = makeEnv();
    const req = new Request("https://x/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "nope" }),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe("invalid_credentials");
  });

  it("returns 401 on missing password", async () => {
    const env = makeEnv();
    const req = new Request("https://x/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid JSON", async () => {
    const env = makeEnv();
    const req = new Request("https://x/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it("returns 500 when APP_PASSWORD is not configured", async () => {
    const env = makeEnv({ APP_PASSWORD: undefined });
    const req = new Request("https://x/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "x" }),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(500);
  });

  it("returns 200 with an HttpOnly session cookie on the correct password", async () => {
    const env = makeEnv();
    const req = new Request("https://x/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-app-password" }),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
  });

  it("does not leak the Bearer key into the cookie value", async () => {
    const env = makeEnv();
    const req = new Request("https://x/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-app-password" }),
    });
    const res = await worker.fetch(req, env);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).not.toContain("test-api-key-123");
  });
});

describe("POST /api/auth/logout", () => {
  let worker;
  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../src/index.js");
    worker = mod.default;
  });

  it("returns 200 and clears the session cookie", async () => {
    const env = makeEnv();
    const req = new Request("https://x/api/auth/logout", { method: "POST" });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("Max-Age=0");
  });
});

describe("Auth gate integration (regression for the voice path)", () => {
  let worker;
  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }))
    );
    const mod = await import("../src/index.js");
    worker = mod.default;
  });
  afterEach(() => vi.restoreAllMocks());

  it("GET /api/tasks is 401 anonymous", async () => {
    const env = makeEnv();
    const req = new Request("https://x/api/tasks", { method: "GET" });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("GET /api/tasks is 200 with Bearer (voice path unaffected)", async () => {
    const env = makeEnv();
    const req = new Request("https://x/api/tasks", {
      method: "GET",
      headers: { authorization: "Bearer test-api-key-123" },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
  });

  it("GET /api/tasks is 200 with a session cookie", async () => {
    const env = makeEnv();
    const token = await createSessionToken(env, "owner");
    const req = new Request("https://x/api/tasks", {
      method: "GET",
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
  });

  it("POST /api/tasks with Bearer still returns 201 and reaches SessionDO", async () => {
    const env = makeEnv();
    const mockTask = {
      id: "mock-task-id",
      title: "buy milk",
      parent_id: null,
      due_date: null,
      priority: "medium",
      category: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const chainable = {
      run: vi.fn(async () => {}),
      first: vi.fn(async () => mockTask),
      all: vi.fn(async () => ({ results: [] })),
    };
    const bindFn = vi.fn(() => chainable);
    env.TIMON_META.prepare = vi.fn(() => ({
      run: vi.fn(async () => {}),
      all: vi.fn(async () => ({ results: [] })),
      bind: bindFn,
    }));

    const req = new Request("https://x/api/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-api-key-123",
      },
      body: JSON.stringify({ text: "buy milk" }),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(201);
  });
});

describe("timingSafeEqual", () => {
  it("matches identical secrets", () => {
    expect(timingSafeEqual("hunter2", "hunter2")).toBe(true);
  });

  it("rejects a different secret of the same length", () => {
    expect(timingSafeEqual("hunter2", "hunter3")).toBe(false);
  });

  it("rejects on a length mismatch without throwing", () => {
    expect(timingSafeEqual("short", "a much longer secret")).toBe(false);
    expect(timingSafeEqual("", "x")).toBe(false);
  });

  it("rejects a missing or non-string secret", () => {
    // env.APP_PASSWORD being undefined must never compare equal to anything.
    expect(timingSafeEqual("anything", undefined)).toBe(false);
    expect(timingSafeEqual(undefined, undefined)).toBe(false);
    expect(timingSafeEqual(null, "x")).toBe(false);
    expect(timingSafeEqual({}, "x")).toBe(false);
  });

  it("compares multi-byte characters by byte", () => {
    expect(timingSafeEqual("contraseña", "contraseña")).toBe(true);
    expect(timingSafeEqual("contraseña", "contrasena")).toBe(false);
  });
});
