/**
 * A scanner that cannot open its storage shows why, with a retry - never an
 * endless "Loading…" (Fable sign-off, 2026-10-14: `ScannerApp` swallowed the
 * rejection) - and never offers to wipe that storage, which may hold check-ins
 * that have not reached WoCo yet.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import * as db from "../src/lib/scanner/db.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const read = (rel: string) => readFileSync(join(here, "../src", rel), "utf8");

const { compile } = await import("svelte/compiler");
const { render } = await import("svelte/server");
// Inside the package, so the compiled module resolves `svelte/internal/server`; removed after.
const out = mkdtempSync(join(here, "../node_modules/.boot-failed-render-"));
test.after(() => rmSync(out, { recursive: true, force: true }));
const compiled = compile(read("lib/scanner/BootFailed.svelte"), { generate: "server", filename: "BootFailed.svelte" });
const file = join(out, "BootFailed.js");
writeFileSync(file, compiled.js.code);
const BootFailed = (await import(pathToFileURL(file).href)).default;

test("render: the failure says what happened, that nothing was deleted, and offers a retry - only", () => {
  const html = render(BootFailed, { props: { onRetry: () => {} } }).body;
  assert.match(html, /couldn't start/);
  assert.match(html, /Nothing stored on it has been deleted/);
  assert.match(html, /<button[^>]*>Try again<\/button>/);
  assert.equal((html.match(/<button/g) ?? []).length, 1, "no reset beside the retry");
  assert.doesNotMatch(html, /reset|clear|delete this/i);
});

test("a boot that throws lands on that screen, and its retry boots again", () => {
  const app = read("ScannerApp.svelte");
  assert.match(app, /\{:else if scanner\.phase === "failed"\}\s*<BootFailed onRetry=\{\(\) => void scanner\.init\(\)\} \/>/);
  const store = read("lib/scanner/store.svelte.ts");
  const init = store.slice(store.indexOf("  async init(): Promise<void> {"), store.indexOf("  private listen(): void {"));
  assert.match(init, /try \{\s*await this\.boot\(\);\s*\} catch \(err\) \{[^}]*this\.phase = "failed";/);
  assert.ok(init.indexOf("takePassFromUrl(") < init.indexOf("this.boot()"), "the pass leaves the URL before storage is touched");
});

test("storage that fails to open is not remembered as failed: the retry opens it", async () => {
  const real = new IDBFactory();
  let failures = 1;
  const flaky = new Proxy(real, {
    get(target, prop) {
      if (prop === "open") {
        return (...args: Parameters<IDBFactory["open"]>) => {
          if (args[0] === "woco-scanner-v2" && failures-- > 0) throw new DOMException("storage unavailable", "UnknownError");
          return target.open(...args);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  db.useIndexedDbForTests(flaky);
  await assert.rejects(db.getDeviceId());
  assert.match(await db.getDeviceId(), /^[0-9a-f]{16}$/);
});
