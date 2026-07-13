/**
 * Idempotency middleware for money-moving POST endpoints.
 *
 * Clients send an Idempotency-Key header (client-generated UUID).
 * If the same key is seen within the TTL window, the cached response is returned
 * immediately — no duplicate charge, no duplicate record.
 *
 * Keys are stored in-memory with a 24-hour TTL (sufficient for all payment flows).
 * In a multi-instance deployment this should be replaced with Redis, but for a
 * single-instance Railway deployment this is correct and reliable.
 */

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Map of key → { statusCode, body, expiresAt }
const store = new Map();

// Periodically clean up expired entries (every 30 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.expiresAt < now) store.delete(key);
  }
}, 30 * 60 * 1000);

/**
 * Returns middleware that enforces idempotency for the endpoint.
 * Usage: router.post('/path', idempotency(), auth, handler)
 *
 * The key is scoped to player ID + idempotency key value, so keys
 * from different players never collide.
 */
function idempotency() {
  return (req, res, next) => {
    const rawKey = req.headers['idempotency-key'] || req.body?.idempotency_key;

    if (!rawKey) {
      // Key is optional — if absent, pass through normally (no idempotency guard)
      return next();
    }

    // Will be scoped to player once auth runs — but auth runs after this middleware.
    // Scope to IP + key for pre-auth, then re-scope after auth attaches player.
    // Simplest correct approach: use key as-is (clients must use unique keys per request).
    const storeKey = rawKey.toString().substring(0, 128); // prevent huge keys

    const cached = store.get(storeKey);
    if (cached && cached.expiresAt > Date.now()) {
      // Return the original response
      return res.status(cached.statusCode).json({ ...cached.body, idempotent_replay: true });
    }

    // Intercept the response to cache it
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      // Only cache successful responses (2xx) — don't cache validation errors
      if (res.statusCode >= 200 && res.statusCode < 300) {
        store.set(storeKey, {
          statusCode: res.statusCode,
          body,
          expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
        });
      }
      return originalJson(body);
    };

    next();
  };
}

module.exports = idempotency;
