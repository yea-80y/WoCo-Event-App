/**
 * The scanner's start-up path never loads the lattice code (owner: keep the app
 * lightweight). X-Wing (ML-KEM-768) and the sealed box are needed only to open door
 * entries, so `door-entries.ts` reaches them with a dynamic `import()` when there is
 * a line to open. This walks every STATIC import from the scanner's entry
 * (`scanner-main.ts`, through `.ts` and `.svelte` modules and `@woco/shared`
 * subpaths) and fails if any of it is in that graph - the same rule as
 * `xwing-lazy-load.test.ts`, for the scanner bundle as a whole.
 *
 * MUTATION: import `doorEntriesKeypair` statically in door-entries.ts and the first
 * test goes red, naming the chain.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_SRC = fileURLToPath(new URL("../src", import.meta.url));
const SHARED_SRC = fileURLToPath(new URL("../../../packages/shared/src", import.meta.url));

/** The lattice code and what only it needs. */
const LATTICE = [
  /packages\/shared\/src\/crypto\/xwing(-hpke)?\.ts$/,
  /packages\/shared\/src\/crypto\/sealed-box\.ts$/,
  /packages\/shared\/src\/checkin\/door-entries-key\.ts$/,
  /^npm:@noble\/post-quantum/,
  /^npm:@hpke\//,
];

/** Static `import ... from` / `export ... from` / side-effect imports; never `import type` or `import()`. */
function staticSpecifiers(code: string): string[] {
  const out: string[] = [];
  const re = /^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']/gm;
  for (const m of code.matchAll(re)) out.push(m[1]);
  return out;
}

function scriptOf(file: string): string {
  const text = readFileSync(file, "utf8");
  if (!file.endsWith(".svelte")) return text;
  return [...text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
}

function resolveFile(base: string): string | null {
  const noJs = base.replace(/\.js$/, "");
  for (const c of [base, `${noJs}.ts`, `${noJs}.svelte`, join(base, "index.ts")]) {
    if (existsSync(c) && !c.endsWith("/")) return c;
  }
  return null;
}

/** A node id: an absolute source path, or `npm:<package path>` for a dependency (not walked). */
function resolveSpecifier(spec: string, from: string): string | null {
  if (spec.startsWith(".")) return resolveFile(resolve(dirname(from), spec));
  if (spec === "@woco/shared") return join(SHARED_SRC, "index.ts");
  if (spec.startsWith("@woco/shared/")) return resolveFile(join(SHARED_SRC, spec.slice("@woco/shared/".length)));
  if (spec.endsWith(".css") || spec.startsWith("virtual:")) return null;
  return `npm:${spec}`;
}

/** Every module statically reachable from `entry`, each with the chain that reached it. */
function staticGraph(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[entry, [entry]]]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (file.startsWith("npm:")) continue;
    for (const spec of staticSpecifiers(scriptOf(file))) {
      const next = resolveSpecifier(spec, file);
      if (!next || seen.has(next)) continue;
      seen.set(next, [...seen.get(file)!, next]);
      queue.push(next);
    }
  }
  return seen;
}

const short = (p: string) => p.replace(/^.*\/(apps|packages)\//, "$1/");

test("nothing on the scanner's start-up path statically loads X-Wing or the sealed box", () => {
  const graph = staticGraph(join(WEB_SRC, "scanner-main.ts"));
  const offenders = [...graph.entries()]
    .filter(([id]) => LATTICE.some((re) => re.test(id)))
    .map(([, chain]) => chain.map(short).join(" -> "));
  assert.deepEqual(offenders, []);
});

test("the walk sees what it should: the store, door-entries.ts and the shared index are on the path", () => {
  const graph = staticGraph(join(WEB_SRC, "scanner-main.ts"));
  const ids = [...graph.keys()].map(short);
  for (const must of ["apps/web/src/lib/scanner/store.svelte.ts", "apps/web/src/lib/scanner/door-entries.ts", "apps/web/src/ScannerApp.svelte", "packages/shared/src/index.ts"]) {
    assert.ok(ids.includes(must), must);
  }
});

test("door-entries.ts reaches the lattice code only through import()", () => {
  const src = readFileSync(join(WEB_SRC, "lib/scanner/door-entries.ts"), "utf8");
  assert.match(src, /import\("@woco\/shared\/crypto\/sealed-box"\)/);
  assert.match(src, /import\("@woco\/shared\/checkin\/door-entries-key"\)/);
  assert.equal(staticSpecifiers(src).filter((s) => /sealed-box|xwing|door-entries-key/.test(s)).length, 0);
});

test("the walker itself: a static import is followed, a type import and a dynamic import are not", () => {
  assert.deepEqual(
    staticSpecifiers([
      'import { a } from "./a.js";',
      'import type { B } from "./b.js";',
      'export { c } from "./c.js";',
      'import "./side.css";',
      'const d = await import("./d.js");',
      "import {\n  e,\n  f,\n} from \"./ef.js\";",
    ].join("\n")),
    ["./a.js", "./c.js", "./side.css", "./ef.js"],
  );
});
