/**
 * startModuleWorker (#1087): a Worker from the page's own origin starts directly; one
 * from another origin (the app's chunks on woco.eth.limo) starts from a same-origin
 * blob whose only content imports that exact URL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { moduleWorkerStarter, type ModuleWorkerEnv } from "../src/web/module-worker.js";

const GATEWAY = "https://gateway.woco-net.com/bzz/0a7b/";

function world(page: { origin: string; baseURI: string }) {
  const started: { url: string; options?: WorkerOptions }[] = [];
  const blobs: { url: string; text: Promise<string>; type: string }[] = [];
  class FakeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      started.push({ url: String(url), options });
    }
  }
  const env: ModuleWorkerEnv = {
    Worker: FakeWorker as unknown as ModuleWorkerEnv["Worker"],
    createObjectURL(blob: Blob) {
      const url = `blob:${page.origin}/${blobs.length}`;
      blobs.push({ url, text: blob.text(), type: blob.type });
      return url;
    },
    baseURI: () => page.baseURI,
    origin: () => page.origin,
  };
  return { start: moduleWorkerStarter(env), started, blobs };
}

test("same origin: started directly from the chunk, as a module", () => {
  const w = world({ origin: "https://gateway.woco-net.com", baseURI: GATEWAY });
  w.start("https://gateway.woco-net.com/bzz/0a7b/assets/parse-worker-AbC1.js");
  assert.deepEqual(w.started, [{ url: "https://gateway.woco-net.com/bzz/0a7b/assets/parse-worker-AbC1.js", options: { type: "module" } }]);
  assert.equal(w.blobs.length, 0);
});

test("relative URLs resolve against the document's base, as new Worker does", () => {
  // The embed frame: /embed/assets/... on the API origin.
  const frame = world({ origin: "https://events-api.woco-net.com", baseURI: "https://events-api.woco-net.com/embed/seatmap/e/s" });
  frame.start("/embed/assets/parse-worker-AbC1.js");
  assert.deepEqual(frame.started.map((s) => s.url), ["https://events-api.woco-net.com/embed/assets/parse-worker-AbC1.js"]);
  assert.equal(frame.blobs.length, 0);
  // woco.eth.limo: the <base href> is the gateway, so a relative URL lands there - cross-origin.
  const limo = world({ origin: "https://woco.eth.limo", baseURI: GATEWAY });
  limo.start("assets/parse-worker-AbC1.js");
  assert.equal(limo.blobs.length, 1);
});

test("cross origin: a same-origin blob that statically imports exactly that URL", async () => {
  const w = world({ origin: "https://woco.eth.limo", baseURI: GATEWAY });
  const href = "https://gateway.woco-net.com/bzz/0a7b/assets/order-opener.worker-C5Xm.js";
  w.start(href);
  assert.equal(w.blobs.length, 1);
  assert.equal(await w.blobs[0].text, `import "${href}";`);
  assert.equal(w.blobs[0].type, "text/javascript");
  assert.deepEqual(w.started, [{ url: w.blobs[0].url, options: { type: "module" } }]);
});

test("the import is a quoted string literal, whatever the URL holds", async () => {
  // The URL parser encodes `"` everywhere, but a backslash survives in the query: written
  // raw into a literal it would escape the next character and name another URL.
  const raw = `https://gateway.woco-net.com/a/"x";alert(1)//.js?q=\\u0041\\"`;
  const href = new URL(raw).href;
  assert.ok(href.includes("\\"), "the case under test keeps its backslash");
  const w = world({ origin: "https://woco.eth.limo", baseURI: GATEWAY });
  w.start(raw);
  const text = await w.blobs[0].text;
  // One statement: `import "<one JSON string>";` - nothing after the closing quote.
  assert.match(text, /^import "(?:[^"\\]|\\.)*";$/);
  assert.equal(JSON.parse(text.slice("import ".length, -1)), href, "the literal names exactly the parsed URL");
});

test("one shim per chunk: a pool of workers reuses it, another chunk gets its own", () => {
  const w = world({ origin: "https://woco.eth.limo", baseURI: GATEWAY });
  const a = "https://gateway.woco-net.com/bzz/0a7b/assets/a.js";
  const b = "https://gateway.woco-net.com/bzz/0a7b/assets/b.js";
  w.start(a);
  w.start(a);
  w.start(b);
  assert.equal(w.blobs.length, 2);
  assert.deepEqual(w.started.map((s) => s.url), [w.blobs[0].url, w.blobs[0].url, w.blobs[1].url]);
});

test("not http(s): started directly, left to the page's policy", () => {
  const w = world({ origin: "https://woco.eth.limo", baseURI: GATEWAY });
  w.start("data:text/javascript,1");
  assert.equal(w.blobs.length, 0);
  assert.deepEqual(w.started.map((s) => s.url), ["data:text/javascript,1"]);
});

test("a starter that cannot construct throws to its caller (every caller falls back to the page)", () => {
  const env: ModuleWorkerEnv = {
    Worker: class {
      constructor() {
        throw new DOMException("refused", "SecurityError");
      }
    } as unknown as ModuleWorkerEnv["Worker"],
    createObjectURL: () => "blob:https://woco.eth.limo/1",
    baseURI: () => GATEWAY,
    origin: () => "https://woco.eth.limo",
  };
  assert.throws(() => moduleWorkerStarter(env)("assets/x.js"), { name: "SecurityError" });
});
