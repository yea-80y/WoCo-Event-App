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
