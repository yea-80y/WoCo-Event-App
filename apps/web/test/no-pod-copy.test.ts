/**
 * "POD" is retired as a NAME (owner decision 2026-09-01, #515/#458). What a user
 * READS is now "object(s)" in the organiser studio and "collection" on the
 * attendee side. What the machine reads — identifiers (`PodCard`, `podSeed`,
 * `ensurePodIdentity`), routes (`/creator/pods`), feed topics (`woco/pod/*`),
 * storage keys (`StorageKeys.POD_SEED`) and the frozen signed literals — keeps
 * its exact bytes, and the comments are deliberately left speaking the old
 * vocabulary because they explain the wire format, not the product.
 *
 * A retired label is one careless edit away from coming back, and nothing else
 * in this suite reads copy at all. So: walk the whole frontend source, strip the
 * comments, and fail on the bare word wherever it survives.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/**
 * The word may survive ONLY on these exact lines. Scoped to a line, not a file,
 * so a NEW "PODs" label added to an allowlisted file still fails here.
 */
const ALLOWLIST: ReadonlyArray<{ file: string; line: string; why: string }> = [
  {
    file: "lib/auth/pod-identity.ts",
    line: `purpose: "Derive deterministic POD signing identity",`,
    why:
      "An EIP-712 SIGNED field (DerivePodIdentity.purpose). The signature over " +
      "these exact bytes is hashed into the seed every one of a user's keys is " +
      "derived from — editing the copy would silently re-derive a different " +
      "identity for every existing account and orphan their feeds.",
  },
];

const POD_WORD = /\bPODs?\b/;

/**
 * Blank out comments while preserving line numbers and every non-comment byte.
 * String-aware, so a `//` inside a string literal (a URL, a path) is not read as
 * the start of a comment — over-stripping would blind the guard, which is the
 * one failure mode a guard must not have.
 */
function stripJsComments(src: string): string {
  let out = "";
  let state: "code" | "line" | "block" | "'" | '"' | "`" = "code";
  let i = 0;
  const blank = (c: string) => (c === "\n" || c === "\t" ? c : " ");
  while (i < src.length) {
    const c = src[i]!;
    const d = src[i + 1];
    if (state === "code") {
      if (c === "/" && d === "/") { state = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && d === "*") { state = "block"; out += "  "; i += 2; continue; }
      if (c === "'" || c === '"' || c === "`") state = c;
      out += c; i += 1; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; i += 1; continue; }
      out += blank(c); i += 1; continue;
    }
    if (state === "block") {
      if (c === "*" && d === "/") { state = "code"; out += "  "; i += 2; continue; }
      out += blank(c); i += 1; continue;
    }
    // inside a string literal
    if (c === "\\") { out += c + (d ?? ""); i += 2; continue; }
    if (c === state) state = "code";
    // an unterminated single/double quote (an apostrophe in template prose)
    // must not swallow the rest of the file
    else if (c === "\n" && state !== "`") state = "code";
    out += c; i += 1; continue;
  }
  return out;
}

function stripHtmlComments(src: string): string {
  return src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

export function stripComments(src: string, isSvelte: boolean): string {
  if (!isSvelte) return stripJsComments(src);
  // In a Svelte file only `<script>` bodies are JavaScript; `//` in template
  // prose or in an href is text, not a comment.
  return stripHtmlComments(src).replace(
    /(<script[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_m, open: string, body: string, close: string) => open + stripJsComments(body) + close,
  );
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, acc);
    else if (p.endsWith(".ts") || p.endsWith(".svelte")) acc.push(p);
  }
  return acc;
}

/** Every non-comment line still carrying the word, allowlisted lines removed. */
function findPodCopy(): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const path of sourceFiles(SRC)) {
    const file = relative(SRC, path).split(sep).join("/");
    const original = readFileSync(path, "utf-8").split("\n");
    const stripped = stripComments(readFileSync(path, "utf-8"), path.endsWith(".svelte")).split("\n");
    stripped.forEach((line, i) => {
      if (!POD_WORD.test(line)) return;
      const text = original[i]!.trim();
      if (ALLOWLIST.some((a) => a.file === file && a.line === text)) return;
      hits.push({ file, line: i + 1, text });
    });
  }
  return hits;
}

test("the word boundary spares identifiers, storage keys and comments", () => {
  // These are the shapes the sweep deliberately did NOT touch. If the pattern
  // ever starts matching them, the guard turns into a rename bot.
  for (const safe of [
    "const k = StorageKeys.POD_SEED;",
    "import PodCard from './PodCard.svelte';",
    "await auth.ensurePodIdentity();",
    'navigate("/creator/pods");',
    'topic("woco/pod/collection/" + addr)',
  ]) {
    assert.ok(!POD_WORD.test(safe), `pattern should not match code: ${safe}`);
  }
  // …and it does match a label.
  assert.ok(POD_WORD.test("<span>PODs</span>"));
  assert.ok(POD_WORD.test("Create a POD"));
});

test("stripping drops comments and nothing else", () => {
  const svelte = [
    "<!-- POD manager — an HTML comment -->",
    "<script lang='ts'>",
    "  // POD seed: comments keep the old vocabulary on purpose",
    "  /* POD identity lives here */",
    "  const k = StorageKeys.POD_SEED; // a trailing POD note",
    '  const href = "https://gateway.woco-net.com/bzz/x"; // not a comment above',
    "</script>",
    "<a href='https://woco.eth.limo'>Collectibles</a>",
    "<p>Don't let an apostrophe swallow the file</p>",
  ].join("\n");
  const cleaned = stripComments(svelte, true);
  assert.ok(!POD_WORD.test(cleaned), `comments survived stripping:\n${cleaned}`);
  // The non-comment content is still there to be scanned — over-stripping would
  // make every future check pass for the wrong reason.
  assert.ok(cleaned.includes("StorageKeys.POD_SEED"));
  assert.ok(cleaned.includes("https://gateway.woco-net.com/bzz/x"));
  assert.ok(cleaned.includes("Collectibles"));

  // A label in template prose survives stripping and IS found, even on a line
  // whose text contains `//`.
  const labelled = "<a href='https://woco.eth.limo'>PODs</a>";
  assert.ok(POD_WORD.test(stripComments(labelled, true)));

  // Same for a plain .ts file: comment blanked, string kept.
  const ts = ['// POD seed', 'const msg = "Failed to load PODs";'].join("\n");
  const cleanedTs = stripComments(ts, false);
  assert.ok(!POD_WORD.test(cleanedTs.split("\n")[0]!));
  assert.ok(POD_WORD.test(cleanedTs.split("\n")[1]!));
});

test("no user-visible string in apps/web/src says POD", () => {
  const hits = findPodCopy();
  assert.deepEqual(
    hits,
    [],
    "POD is retired as a user-facing name — say object(s) in the organiser " +
      "studio, collection on the attendee side, ticket/badge where the thing is " +
      "specifically one of those:\n" +
      hits.map((h) => `  ${h.file}:${h.line}  ${h.text}`).join("\n"),
  );
});

test("every allowlisted line is still there, saying what it claims", () => {
  // An allowlist entry that no longer matches anything is a stale exemption —
  // it would quietly re-open the file it names.
  for (const entry of ALLOWLIST) {
    const src = readFileSync(join(SRC, entry.file), "utf-8");
    assert.ok(
      src.split("\n").some((l) => l.trim() === entry.line),
      `allowlisted line is gone from ${entry.file} — drop the entry: ${entry.line}`,
    );
  }
});
