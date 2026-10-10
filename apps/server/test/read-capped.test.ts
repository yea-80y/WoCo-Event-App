/**
 * `lib/http/read-capped.ts`, plus the guard that keeps every Swarm/Etherna
 * response read in `lib/swarm` and `lib/etherna` going through it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ResponseTooLargeError,
  SWARM_CHUNK_MAX_BYTES,
  errorSnippet,
  readCapped,
  readPrefix,
} from "../src/lib/http/read-capped.js";

/** A Response whose body arrives in `parts`, with an optional declared length. */
function respond(parts: Uint8Array[], contentLength?: number): { resp: Response; pulled: () => number } {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (i < parts.length) ctrl.enqueue(parts[i++]);
      else ctrl.close();
    },
  });
  const headers = contentLength === undefined ? undefined : { "content-length": String(contentLength) };
  return { resp: new Response(body, { headers }), pulled: () => i };
}
const bytes = (n: number, v = 1) => new Uint8Array(n).fill(v);

test("the chunk ceiling is a stored SOC: id + sig + span + 4096", () => {
  assert.equal(SWARM_CHUNK_MAX_BYTES, 32 + 65 + 8 + 4096);
});

test("readCapped returns a body at the cap exactly", async () => {
  const { resp } = respond([bytes(6), bytes(4, 2)]);
  assert.deepEqual(await readCapped(resp, 10, "t"), new Uint8Array([1, 1, 1, 1, 1, 1, 2, 2, 2, 2]));
});

test("readCapped refuses a declared Content-Length over the cap before reading", async () => {
  const { resp, pulled } = respond([bytes(4)], 11);
  await assert.rejects(readCapped(resp, 10, "t"), (e) => e instanceof ResponseTooLargeError && e.status === 413);
  assert.equal(pulled(), 0);
});

test("readCapped stops a lying or absent length mid-stream", async () => {
  const { resp, pulled } = respond([bytes(6), bytes(6), bytes(6), bytes(6)], 5);
  await assert.rejects(readCapped(resp, 10, "t"), ResponseTooLargeError);
  assert.ok(pulled() < 4, "the rest of the stream is never pulled");
});

test("readPrefix keeps the first bytes and drops the rest without error", async () => {
  const { resp } = respond([bytes(6), bytes(6, 2)]);
  assert.deepEqual(await readPrefix(resp, 8), new Uint8Array([1, 1, 1, 1, 1, 1, 2, 2]));
});

test("errorSnippet is bounded and never throws", async () => {
  const { resp } = respond([new TextEncoder().encode("x".repeat(10_000))]);
  assert.equal(await errorSnippet(resp, 50), "x".repeat(50));
  const broken = new Response(new ReadableStream({ pull(c) { c.error(new Error("boom")); } }));
  assert.equal(await errorSnippet(broken), "");
});

test("no uncapped response-body read in lib/swarm or lib/etherna", () => {
  const dirs = ["../src/lib/swarm", "../src/lib/etherna"].map((d) => new URL(d, import.meta.url).pathname);
  const offenders: string[] = [];
  for (const dir of dirs) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      readFileSync(join(dir, f), "utf8").split("\n").forEach((line, i) => {
        if (/\.(arrayBuffer|text|json|blob)\(\)/.test(line) && !/^\s*(\/\/|\*)/.test(line)) {
          offenders.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  }
  assert.deepEqual(offenders, [], "read bodies through lib/http/read-capped.ts");
});
