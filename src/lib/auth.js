// Shared auth helper for the Timon Worker.
//
// `/api/*` accepts EITHER a valid Bearer key (ESP32 / apollo) OR a valid
// session cookie (browser). `isAuthorized` is the single gate used by both the
// HTTP routes and — in NID-529 — the WebSocket upgrade path, so it must stay a
// shared, exported helper and never be inlined into one branch.
//
// Session cookies are HMAC-signed (WebCrypto, no dependency) over a
// `{ sub, exp }` payload. Expired or tampered cookies are a 401, never a crash.

const SESSION_COOKIE = "timon_session";
export const SESSION_MAX_AGE = 30 * 24 * 3600; // 30 days

function toBase64Url(input) {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : new Uint8Array(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(str) {
  const padded =
    str.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmac(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return toBase64Url(sig);
}

// Constant-time-ish comparison of two base64url signatures.
async function verifySig(data, sigB64, secret) {
  let provided;
  try {
    provided = fromBase64Url(sigB64);
  } catch {
    return false;
  }
  const expected = fromBase64Url(await hmac(data, secret));
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided[i] ^ expected[i];
  return diff === 0;
}

// The Bearer gate, unchanged in behaviour from the previous inline version:
// the TIMON_API_KEY is only ever compared server-side and is never shipped to
// the browser.
export function verifyApiKey(request, env) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7);
  return token === env.TIMON_API_KEY;
}

export function getSessionCookie(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name === SESSION_COOKIE) return value;
  }
  return null;
}

export async function verifySessionCookie(request, env) {
  if (!env.SESSION_SECRET) return false;
  const token = getSessionCookie(request);
  if (!token || !token.includes(".")) return false;
  const [payloadB64, sig] = token.split(".");
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)));
  } catch {
    return false;
  }
  if (!(await verifySig(payloadB64, sig, env.SESSION_SECRET))) return false;
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    return false;
  }
  return true;
}

// Single gate for every /api/* route and the WS upgrade: Bearer OR cookie.
export async function isAuthorized(request, env) {
  return verifyApiKey(request, env) || (await verifySessionCookie(request, env));
}

export async function createSessionToken(env, sub = "owner", maxAge = SESSION_MAX_AGE) {
  const exp = Math.floor(Date.now() / 1000) + maxAge;
  const payloadB64 = toBase64Url(JSON.stringify({ sub, exp }));
  const sig = await hmac(payloadB64, env.SESSION_SECRET);
  return `${payloadB64}.${sig}`;
}

export function sessionCookieValue(token) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE}`;
}

export function clearedSessionCookieValue() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export { SESSION_COOKIE };
