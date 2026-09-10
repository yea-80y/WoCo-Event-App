/**
 * Source pins for the consent surface.
 *
 * These are TEXT checks and that limitation is the point of saying so: the
 * dialog and the sheet are Svelte components and their stores are runes modules,
 * neither of which this suite (plain tsx + node:test) can execute. Same shape as
 * login-surface-registration.test.ts.
 *
 * What they defend, in one line each: the human copy is keyed on the EXACT
 * EIP-712 type names, so a rename of the frozen literal cannot silently drop it
 * back to raw bytes; the raw layer never disappears behind the friendly one; the
 * consent surfaces are mounted in BOTH shells (the deployed-site bundle is a
 * separate entry point and has shipped without a modal before, #194); and no
 * call site goes back to counting prompts it cannot count.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".svelte") || p.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

const FILES = walk(SRC).map((path) => ({
  rel: relative(SRC, path).split(sep).join("/"),
  text: readFileSync(path, "utf8"),
}));

const read = (rel: string): string => {
  const f = FILES.find((x) => x.rel === rel);
  assert.ok(f, `${rel} not found`);
  return f!.text;
};

// ---------------------------------------------------------------------------
// 1. The dialog's human layer
// ---------------------------------------------------------------------------

const DIALOG = "lib/components/auth/SigningConfirmDialog.svelte";

test("the human copy is keyed on the exact EIP-712 type names", () => {
  // `action` IS the type name (local-signer.ts / passkey-signer.ts pass it
  // through). These two strings are the join between frozen signed bytes and
  // readable copy: mistype either and the dialog silently falls back to showing
  // a type name and a blob, which is the state this work existed to end.
  const src = read(DIALOG);
  for (const action of ["DeriveAccountKeys", "AuthorizeSession"]) {
    assert.match(
      src,
      new RegExp(`\\b${action}\\b\\s*:`),
      `SigningConfirmDialog must carry human copy keyed on ${action}`,
    );
  }
});

test("the type names the dialog keys on are the ones actually signed", () => {
  // A pin against the copy drifting away from the bytes: if the shared EIP-712
  // types are ever renamed, the dialog's keys have to move with them or the
  // human layer stops matching and nobody notices.
  const shared = fileURLToPath(new URL("../../../packages/shared/src/auth", import.meta.url));
  const signed = walk(shared)
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
  for (const action of ["DeriveAccountKeys", "AuthorizeSession"]) {
    assert.match(
      signed,
      new RegExp(`\\b${action}\\b`),
      `${action} is no longer an EIP-712 type in packages/shared/src/auth`,
    );
  }
});

test("the raw material survives behind the friendly copy", () => {
  // Honesty about the bytes is a requirement, not decoration. A signature
  // request that hides what it signs is worse than an unreadable one.
  const src = read(DIALOG);
  assert.match(
    src,
    /pending\.fields/,
    "the dialog must still render the raw EIP-712 fields",
  );
  assert.match(src, /Show what you're signing/, "the disclosure must be reachable");
  assert.match(src, /<details/, "the raw layer must be a real disclosure, closed by default");
  assert.match(src, /pending\.domainName/, "the domain name must stay visible");
});

test("the primary button paints ink on the accent, not white", () => {
  // `--accent` is acid lime. White on lime is unreadable, and the token for
  // ink-on-accent already exists.
  const src = read(DIALOG);
  const signBtn = /\.sign-btn\s*\{[^}]*\}/.exec(src)?.[0];
  assert.ok(signBtn, ".sign-btn rule not found");
  assert.match(signBtn!, /color:\s*var\(--accent-ink\)/);
  assert.doesNotMatch(signBtn!, /#fff|#ffffff|white/i);
});

// ---------------------------------------------------------------------------
// 2. Both shells mount both consent surfaces
// ---------------------------------------------------------------------------

test("both app shells mount the signing dialog and the setup sheet", () => {
  // SiteApp is the deployed-builder-site entry point — a separate bundle. A
  // consent surface that exists only in App.svelte is absent exactly where an
  // organiser's own site asks someone to sign (#194 was this defect).
  for (const shell of ["App.svelte", "SiteApp.svelte"]) {
    const src = read(shell);
    for (const component of ["SigningConfirmDialog", "AccountSetupSheet"]) {
      assert.match(
        src,
        new RegExp(`import ${component} from`),
        `${shell} does not import ${component}`,
      );
      assert.match(src, new RegExp(`<${component}\\s*/>`), `${shell} does not mount ${component}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 3. The call sites use the one entry point
// ---------------------------------------------------------------------------

test("the setup call sites go through ensureAccountSetup", () => {
  for (const rel of [
    "lib/creator/events/PublishButton.svelte",
    "lib/components/pod/PodCreateModal.svelte",
    "lib/components/profile/ProfilePage.svelte",
  ]) {
    assert.match(
      read(rel),
      /ensureAccountSetup\(/,
      `${rel} must set the account up through the one entry point`,
    );
  }
});

test("the auth store exports ensureAccountSetup", () => {
  const src = read("lib/auth/auth-store.svelte.ts");
  assert.match(src, /async function ensureAccountSetup\(/);
  assert.match(src, /^\s{2}ensureAccountSetup,$/m, "it must be on the public `auth` object");
});

// ---------------------------------------------------------------------------
// 4. Nothing counts prompts again
// ---------------------------------------------------------------------------

/**
 * A comment LINE, by its own first characters. Deliberately line-level rather
 * than a full parse: a label is an assignment or template text, never a line
 * that opens with a comment marker, so this cannot exempt one — and the
 * alternative (a file allowlist) would blind the guard to a whole file.
 */
const isCommentLine = (line: string): boolean =>
  /^(\/\/|\/\*|\*|<!--)/.test(line.trim());

test("no source file counts signature steps at a call site", () => {
  // How many prompts a person sees depends on their login kind and on what is
  // already on their device. A call site cannot know it, and the two that
  // guessed both told passkey users their only prompt was "2 of 2".
  const COUNTING = /of 2\)|\(1 of |\(2 of /;
  const hits: string[] = [];
  for (const f of FILES) {
    f.text.split("\n").forEach((line, i) => {
      if (!COUNTING.test(line) || isCommentLine(line)) return;
      hits.push(`${f.rel}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(
    hits,
    [],
    "step counting is back — the count is not knowable at a call site:\n" + hits.join("\n"),
  );
});

test("the counting guard reads labels, not the comments that explain the ban", () => {
  // A guard that could be silenced by wrapping the label in a comment marker,
  // or that fires on its own rationale, is not a guard.
  assert.ok(isCommentLine(' * and "(2 of 2)" step labels, which were wrong'));
  assert.ok(isCommentLine("// step = \"Approve session (1 of 2)...\""));
  assert.ok(!isCommentLine('      step = "Approve session (1 of 2)...";'));
  assert.ok(!isCommentLine("<p>Approve identity (2 of 2)</p>"));
});
