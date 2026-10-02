/**
 * The post-quantum code stays OUT of the main bundle (#642).
 *
 * X-Wing (ML-KEM-768) and HPKE are ~20 KB gzipped together, needed only where a
 * box is sealed or opened. A STATIC import of them from anything the app loads
 * eagerly would ship that to every visitor. So every static importer is listed
 * here, and each one is itself only ever reached through a dynamic `import()`.
 * Adding a new one fails this test on purpose: load it lazily instead, or add it
 * here with the reason.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED_STATIC_IMPORTERS = new Set([
  // Imported only via `await import("./recovery-escrow.js")` (auth-store, the
  // recovery portal, backup-signer) and by recovery-portability, itself lazy.
  "lib/auth/recovery-escrow.ts",
  // Linking another device (#746 step 4). Every importer uses `await import()`,
  // pinned by the last test below.
  "lib/auth/pairing-channel.ts",
]);

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.(ts|svelte)$/.test(name)) out.push(full);
  }
  return out;
}

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const STATIC = /^\s*import\s+(?!type\b)[^;]*from\s+["']@woco\/shared\/crypto\/(xwing|xwing-hpke|sealed-box)["']/m;

test("only allowlisted modules statically import the X-Wing / sealed-box code", () => {
  const offenders = files(SRC)
    .map((f) => ({ rel: f.slice(SRC.length + 1), text: readFileSync(f, "utf8") }))
    .filter((f) => STATIC.test(f.text) && !ALLOWED_STATIC_IMPORTERS.has(f.rel))
    .map((f) => f.rel);
  assert.deepEqual(offenders, []);
});

test("the allowlisted importer is itself only loaded lazily by the app shell", () => {
  const store = readFileSync(join(SRC, "lib/auth/auth-store.svelte.ts"), "utf8");
  assert.doesNotMatch(store, /^\s*import\s[^;]*from\s+["']\.\/recovery-escrow\.js["']/m);
  assert.match(store, /await import\("\.\/recovery-escrow\.js"\)/);
});

test("the pairing channel is only ever loaded with a dynamic import", () => {
  const staticImport = /^\s*import\s+(?!type\b)[^;]*from\s+["'][^"']*pairing-channel(\.js|\.ts)?["']/m;
  const offenders = files(SRC)
    .map((f) => ({ rel: f.slice(SRC.length + 1), text: readFileSync(f, "utf8") }))
    .filter((f) => staticImport.test(f.text))
    .map((f) => f.rel);
  assert.deepEqual(offenders, []);
});
