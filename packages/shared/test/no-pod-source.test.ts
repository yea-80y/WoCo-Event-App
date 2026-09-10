/**
 * THE SOURCE RATCHET for the 2026-09-10 rename.
 *
 * The retired noun left every code name, file name and wire literal so that a
 * real 0xPARC "POD" (Provable Object Data) integration, if it ever happens,
 * arrives into an EMPTY namespace. That only holds if nothing brings the three
 * letters back — and a rename is one careless edit, one revived branch or one
 * copied snippet away from being undone. So this walks the source and fails.
 *
 * THREE RULES:
 *   1. no FILE or DIRECTORY name carries the noun (case-insensitive substring);
 *   2. no file CONTENT matches {@link RETIRED_NOUN} — comments and strings
 *      included, deliberately: a comment that still speaks the old vocabulary
 *      is how the name comes back;
 *   3. no BARE `object` / `Object` identifier is declared or destructured.
 *      JavaScript owns the `Object` global and TypeScript owns the `object`
 *      type, so the replacement noun is only ever used COMPOUNDED —
 *      `ObjectKind`, `ObjectDirectoryEntry`, `objectEntry`, `objectsRouter`.
 *      `Object.keys(x)` in expression position is the global and is fine; it is
 *      DECLARING one that is not.
 *
 * THERE IS NO ALLOWLIST, and adding one would defeat the point: every exemption
 * this rename could have needed was resolved by renaming the thing instead. The
 * single path skipped is THIS FILE, which has to name what it forbids.
 *
 * It lives in packages/shared because that workspace's suite runs in CI for
 * every workspace, so the guard covers web, server, shared and embed at once.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const SELF = fileURLToPath(import.meta.url);

/** Scanned roots. Every source root plus every workspace's `test/` directory. */
const ROOTS = [
  "apps/web/src",
  "apps/web/test",
  "apps/server/src",
  "apps/server/scripts",
  "apps/server/test",
  "packages/shared/src",
  "packages/shared/test",
  "packages/embed/src",
  "packages/embed/test",
] as const;

/**
 * The noun as a word (`pod`, `pods`) or as a name SEGMENT (`podSeed`, `myPod`,
 * `PodCard`, `POD_SEED`). Case-insensitive, which makes it blunter than the
 * alternatives suggest — `podcast` would fail too. That is the intended
 * trade: the three letters do not belong in a name here at all, and a
 * genuinely-needed word can be spelled around far more cheaply than a revived
 * rename can be found.
 */
export const RETIRED_NOUN = /\bpods?\b|pod[A-Z]|[a-z]Pod\b|Pod[A-Z]|POD_/i;

/**
 * Declaring or destructuring a bare `object` / `Object`. Expression use is fine.
 *
 * The fourth rule is not in the original spec and was added because the first
 * three miss a SHORTHAND destructured parameter — `function f({ object })` has
 * no `=` after the brace and no `:` inside it. It is written so each repetition
 * is anchored by a comma: a `(ident\s*)*` form backtracks catastrophically on a
 * long minified-ish line, which a guard that runs on every CI job cannot afford.
 */
export const BARE_OBJECT_RULES: ReadonlyArray<{ why: string; re: RegExp }> = [
  { why: "declaration", re: /\b(?:const|let|var|function|class|type|interface)\s+[oO]bject\b/ },
  { why: "destructuring assignment", re: /\{[^}]*\b[oO]bject\b[^}]*\}\s*=/ },
  { why: "binding or property name", re: /\b[oO]bject\s*:/ },
  { why: "shorthand destructured binding", re: /\{\s*(?:[A-Za-z0-9_$]+\s*,\s*)*[oO]bject\s*[,}]/ },
];

export const declaresBareObject = (line: string): boolean =>
  BARE_OBJECT_RULES.some((r) => r.re.test(line));

/** Extensions whose CONTENT is scanned. Names are checked on every entry. */
const TEXT = /\.(ts|tsx|js|mjs|cjs|svelte|css|html)$/;
const SKIP_DIR = new Set(["node_modules", "dist", "dist-site", "dist-multisite", ".svelte-kit"]);

type Entry = { rel: string; base: string; isDir: boolean; abs: string };

function walk(abs: string, acc: Entry[] = []): Entry[] {
  for (const base of readdirSync(abs)) {
    const child = join(abs, base);
    const isDir = statSync(child).isDirectory();
    if (isDir && SKIP_DIR.has(base)) continue;
    acc.push({ rel: relative(REPO, child).split(sep).join("/"), base, isDir, abs: child });
    if (isDir) walk(child, acc);
  }
  return acc;
}

const ENTRIES: Entry[] = ROOTS.flatMap((root) => walk(join(REPO, root)));

test("the scan reaches every root it claims to", () => {
  // A moved or renamed directory would otherwise empty the walk and turn every
  // assertion below into a pass that guards nothing.
  for (const root of ROOTS) {
    assert.ok(
      ENTRIES.some((e) => e.rel.startsWith(`${root}/`)),
      `${root} contributed no entries — did it move?`,
    );
  }
  const scanned = ENTRIES.filter((e) => !e.isDir && TEXT.test(e.base));
  assert.ok(scanned.length > 500, `only ${scanned.length} files scanned`);
  assert.ok(scanned.some((e) => e.abs === SELF), "this file must be inside a scanned root");
});

test("no file or directory name carries the retired noun", () => {
  const hits = ENTRIES.filter((e) => e.abs !== SELF && e.base.toLowerCase().includes("pod")).map(
    (e) => e.rel,
  );
  assert.deepEqual(hits, [], `rename these paths:\n  ${hits.join("\n  ")}`);
});

test("no source line carries the retired noun — comments and strings included", () => {
  const hits: string[] = [];
  for (const e of ENTRIES) {
    if (e.isDir || e.abs === SELF || !TEXT.test(e.base)) continue;
    readFileSync(e.abs, "utf-8")
      .split("\n")
      .forEach((line, i) => {
        if (RETIRED_NOUN.test(line)) hits.push(`${e.rel}:${i + 1}  ${line.trim()}`);
      });
  }
  assert.deepEqual(
    hits,
    [],
    "the retired noun is gone from this codebase on purpose — the product noun " +
      "is `object` (always compounded) and the key material is the `identity seed`:\n  " +
      hits.join("\n  "),
  );
});

test("no bare object / Object identifier is declared or destructured", () => {
  const hits: string[] = [];
  for (const e of ENTRIES) {
    if (e.isDir || e.abs === SELF || !TEXT.test(e.base)) continue;
    readFileSync(e.abs, "utf-8")
      .split("\n")
      .forEach((line, i) => {
        if (declaresBareObject(line)) hits.push(`${e.rel}:${i + 1}  ${line.trim()}`);
      });
  }
  assert.deepEqual(
    hits,
    [],
    "compound the name — `ObjectKind`, `objectEntry`, `objectsRouter` — never a " +
      "bare `object`/`Object`, which JavaScript and TypeScript already own:\n  " +
      hits.join("\n  "),
  );
});

test("the noun rule fires on the shapes it exists for", () => {
  for (const bad of [
    "import PodCard from './PodCard.svelte';",
    "const k = StorageKeys.POD_SEED;",
    "await auth.ensurePodIdentity();",
    'topic("woco/pod/collection/" + addr)',
    "// the POD seed is stored per account",
    "<span>PODs</span>",
    "const myPod = entries[0];",
    "holdingSource: \"pod-cert\",",
  ]) {
    assert.ok(RETIRED_NOUN.test(bad), `should have failed: ${bad}`);
  }
  for (const ok of [
    "import ObjectCard from './ObjectCard.svelte';",
    "const k = StorageKeys.IDENTITY_SEED;",
    "await auth.ensureIdentitySeed();",
    "export type ObjectKind = 'ticket' | 'badge';",
    "for (const objectEntry of objects) use(objectEntry);",
    "const keys = Object.keys(x);",
  ]) {
    assert.ok(!RETIRED_NOUN.test(ok), `should have passed: ${ok}`);
  }
});

test("the bare-identifier rule fires on declarations, not on the global", () => {
  for (const bad of [
    "const object = {};",
    "let Object = 1;",
    "function object(x) { return x; }",
    "export interface Object { a: string }",
    "const { object } = payload;",
    "const { a, Object, b } = payload;",
    "function f({ object }) { return object; }",
  ]) {
    assert.ok(declaresBareObject(bad), `should have failed: ${bad}`);
  }
  for (const ok of [
    "const keys = Object.keys(x);",
    "if (Object.prototype.hasOwnProperty.call(row, 'a')) return;",
    "export const FROZEN = Object.freeze({ a: 1 });",
    "const objectEntry = objects[0];",
    "export interface ObjectDirectoryEntry { kind: ObjectKind }",
    "function statementSigningDigest(prefix: string, unsigned: object) {}",
    "const { objects, categories } = dir;",
  ]) {
    assert.ok(!declaresBareObject(ok), `should have passed: ${ok}`);
  }
});
