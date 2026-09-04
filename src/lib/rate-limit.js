// Simple in-memory rate limiter for Cloudflare Workers.
// Uses exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (capped).
// Not distributed across Worker instances, but sufficient for basic protection.

const attempts = new Map();
const WINDOW_MS = 60_000; // 1 minute window
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

export function checkRateLimit(key) {
  const now = Date.now();
  const record = attempts.get(key);

  if (!record || now - record.windowStart > WINDOW_MS) {
    // New window or first attempt
    attempts.set(key, { windowStart: now, count: 1 });
    return { allowed: true, retryAfter: 0 };
  }

  if (record.count >= MAX_ATTEMPTS) {
    const delay = Math.min(
      BASE_DELAY_MS * Math.pow(2, record.count - MAX_ATTEMPTS),
      MAX_DELAY_MS
    );
    const retryAfter = Math.ceil(
      (record.windowStart + delay - now) / 1000
    );
    return { allowed: false, retryAfter: Math.max(retryAfter, 1) };
  }

  record.count++;
  return { allowed: true, retryAfter: 0 };
}

export function resetRateLimit(key) {
  attempts.delete(key);
}

// Cleanup old entries every 1000 calls (approximate)
let callCount = 0;
export function maybeCleanup() {
  if (++callCount % 1000 === 0) {
    const now = Date.now();
    for (const [key, record] of attempts) {
      if (now - record.windowStart > WINDOW_MS * 2) {
        attempts.delete(key);
      }
    }
  }
}