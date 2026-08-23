/**
 * The body cap answers in the API's shape and sits in front of the auth
 * middleware's body read (#176).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { jsonBodyLimit } from "../src/lib/http/body-limit.js";

function app(maxBytes: number) {
  const a = new Hono();
  // A stand-in for requireAuth: reads the raw body text before the handler.
  a.post("/x", jsonBodyLimit(maxBytes), async (c, next) => {
    const text = await c.req.text();
    c.set("len" as never, text.length as never);
    await next();
  }, (c) => c.json({ ok: true, len: c.get("len" as never) }));
  return a;
}

test("under the cap passes through and the body is still readable downstream", async () => {
  const res = await app(16).request("/x", { method: "POST", body: "0123456789" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, len: 10 });
});

test("over the cap (Content-Length) is a JSON 413, not plain text", async () => {
  const res = await app(16).request("/x", { method: "POST", body: "x".repeat(17) });
  assert.equal(res.status, 413);
  const json = (await res.json()) as { ok: boolean; error: string };
  assert.equal(json.ok, false);
  assert.match(json.error, /exceeds 16 bytes/);
});

test("over the cap with a streamed body is refused too", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(10)));
      controller.enqueue(new TextEncoder().encode("x".repeat(10)));
      controller.close();
    },
  });
  const res = await app(16).request("/x", {
    method: "POST",
    body: stream,
    // @ts-expect-error — undici needs duplex for a streamed request body
    duplex: "half",
  });
  assert.equal(res.status, 413);
});

test("a bodiless request is untouched", async () => {
  const a = new Hono();
  a.get("/y", jsonBodyLimit(1), (c) => c.json({ ok: true }));
  const res = await a.request("/y");
  assert.equal(res.status, 200);
});

test("rejects a nonsense cap at construction", () => {
  assert.throws(() => jsonBodyLimit(0));
});
