/**
 * The passkey-removal screens (#186): loaded only when there is something to say, the
 * confirm says what a removal does, and an unfinished one is finished by the person.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("the status loads lazily, in both shells, only when there is something to say", () => {
  for (const shell of ["CreatorShell", "AttendeeShell"]) {
    const src = read(`../src/lib/layouts/${shell}.svelte`);
    assert.match(
      src,
      /\{#if auth\.removalProgress \|\| auth\.pendingRemoval \|\| auth\.removalDone \|\| auth\.keyRingNotice\}\s*\{#await import\("\.\.\/components\/passkeys\/KeyRingStatus\.svelte"\)/,
      shell,
    );
  }
});

test("an unfinished removal is finished on the person's press; the confirm names what moves", () => {
  const status = read("../src/lib/components/passkeys/KeyRingStatus.svelte");
  assert.match(status, /onclick=\{finish\}[^>]*>\{finishing \? "Finishing…" : "Finish removing"\}/);
  assert.match(status, /await auth\.finishRemoval\(\);/);
  const screen = read("../src/lib/components/passkeys/YourPasskeys.svelte");
  assert.match(screen, /WoCo gives your account new keys and moves\s+your events, websites and profile over to them\./);
  assert.match(screen, /\{removing === r\.key \? "Removing…" : "Remove passkey"\}/);
  // A hint only, never a prompt: the confirm reads no passkey.
  assert.match(screen, /void auth\.passkeysWithoutKeys\(\)\.then/);
});
