/**
 * Request-body cap that answers in the API's own shape.
 *
 * Hono's `bodyLimit` refuses with a plain-text 413, and `authPost` on the client
 * parses every response as JSON — a bare-text refusal surfaces there as a parse
 * failure rather than as the error it is (the same trap as Hono's default 404,
 * see CLAUDE.md). So the refusal is rendered as `{ ok: false, error }`.
 *
 * Mount it BEFORE `requireAuth` on a route: the auth middleware reads the raw
 * body (`c.req.text()`) to hash it for the canonical challenge, and the cap has
 * to wrap the body stream before anything reads it.
 */
import { bodyLimit } from "hono/body-limit";

export function jsonBodyLimit(maxBytes: number) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error(`jsonBodyLimit: bad maxBytes ${maxBytes}`);
  return bodyLimit({
    maxSize: maxBytes,
    onError: (c) => c.json({ ok: false, error: `Request body exceeds ${maxBytes} bytes` }, 413),
  });
}

/**
 * Process-wide ceiling for `/api/*` request bodies (#176 "consider a global
 * bodyLimit"). Sized from the largest body any route honestly accepts — the
 * event image upload (`routes/events.ts`, 8 MB of image bytes, which is ~10.7 MB
 * as base64 inside JSON) — with headroom; the next largest are the check-in
 * roster (4 MB ciphertext), site images (4 MB) and avatars (2 MB). Per-route
 * caps stay where they are: this is the backstop that stops an unbounded body
 * from reaching any handler that forgot one, not a replacement for them.
 *
 * Mount it on `/api/*` only — the webhook receivers and `/t`, `/u` are tiny, but
 * they are not this change's to retune.
 */
export const API_MAX_BODY_BYTES = 16 * 1024 * 1024;

export function apiBodyLimit() {
  return jsonBodyLimit(API_MAX_BODY_BYTES);
}

