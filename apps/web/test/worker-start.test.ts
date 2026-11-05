/**
 * Our Workers start through `startModuleWorker` (@woco/shared/web/module-worker, #1087).
 * On woco.eth.limo the app's chunks are on the gateway's origin and `new Worker(url)`
 * throws there, so every big job silently ran on the page instead. These pin that no
 * worker goes back to the direct start, and that each one is reached from its URL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.(ts|svelte)$/.test(name)) out.push(full);
  }
  return out;
}

const ROOTS = ["../src", "../../../packages/seatmap/src", "../../../packages/seatmap/svelte", "../../../packages/embed/src"].map((p) =>
  fileURLToPath(new URL(p, import.meta.url)),
);
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("no worker starts from a URL directly", () => {
  // qr-scanner (a dependency) makes its own blob worker; nothing of ours may.
  const direct = ROOTS.flatMap((root) =>
    files(root)
      .filter((f) => /new\s+(Shared)?Worker\s*\(/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(root.length + 1)),
  );
  assert.deepEqual(direct, []);
});

test("each worker is reached from its URL (`?worker&url`), never bundled into its starter", () => {
  const specifiers = ROOTS.flatMap((root) =>
    files(root).flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"'\n]*\?(?:shared)?worker[^"'\n]*)["']/g)].map((m) => m[1]),
    ),
  );
  assert.deepEqual(specifiers.sort(), [
    "./bundle-verify.worker.ts?worker&url",
    "./order-opener.worker.ts?worker&url",
    "./parse-worker.ts?worker&url",
  ]);
});

test("the seat plan parser: the URL loaded only on the worker path, started through the shared starter", () => {
  const parse = read("../../../packages/seatmap/src/parse.ts");
  assert.match(parse, /^import \{ startModuleWorker \} from "@woco\/shared\/web\/module-worker";$/m);
  assert.match(
    parse,
    /const \{ default: workerUrl \} = await import\("\.\/parse-worker\.ts\?worker&url"\);\s*worker = startModuleWorker\(workerUrl\);/,
  );
  // Inside the try: a starter that throws still falls back to parsing on the page.
  const tryBlock = parse.slice(parse.indexOf("  try {"), parse.indexOf("  } catch {"));
  assert.match(tryBlock, /startModuleWorker\(workerUrl\)/);
});
