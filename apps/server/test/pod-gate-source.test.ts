/**
 * The gate write boundary's refusals that must fire BEFORE any network read.
 *
 * These three run with no chain RPC and no Swarm fetch, and that is the point
 * being tested as much as the refusal itself: a gate config that can never open
 * — or that this build cannot evaluate — must be rejected without depending on
 * anything that can be down. `validatePodGate` guards the money path
 * (`event/service.ts` at publish, `shops.ts` at catalogue write), so a refusal
 * that needed the network would become an outage-shaped hole.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CertPodGate, ChainPodGate, PodGate } from "@woco/shared";
import { validatePodGate } from "../src/lib/pod/gate-check.js";

const BADGE = `0x${"ab".repeat(32)}`;
const OTHER_BADGE = `0x${"cd".repeat(32)}`;
const SWARM_REF = "ef".repeat(32);

function certGate(over: Partial<CertPodGate> = {}): CertPodGate {
  return { holdingSource: "pod-cert", manifestRef: BADGE, swarmManifestRef: SWARM_REF, ...over };
}

function chainGate(over: Partial<ChainPodGate> = {}): ChainPodGate {
  return { manifestRef: BADGE, onChainEventId: `0x${"11".repeat(32)}`, chainId: 421614, ...over };
}

test("the same badge twice in one group is refused, with no I/O", async () => {
  const v = await validatePodGate({ mode: "all", gates: [chainGate(), certGate()] });
  assert.ok(!v.ok);
  assert.match(v.error!, /listed twice/);
});

test("a certificate gate demanding more than one is refused, with no I/O", async () => {
  const v = await validatePodGate(certGate({ minCount: 3 } as Partial<CertPodGate>));
  assert.ok(!v.ok);
  assert.match(v.error!, /not how many/);
});

test("a certificate gate asking for first-N is refused, with no I/O", async () => {
  const v = await validatePodGate({ ...certGate(), maxSlotExclusive: 50 } as unknown as PodGate);
  assert.ok(!v.ok);
  assert.match(v.error!, /first-N/);
});

test("a holding source this build cannot evaluate is refused, with no I/O", async () => {
  const v = await validatePodGate({
    manifestRef: BADGE,
    holdingSource: "attestation-v3",
  } as unknown as PodGate);
  assert.ok(!v.ok);
  assert.match(v.error!, /does not know how to check/);
});

test("an empty gate group is still refused", async () => {
  const v = await validatePodGate({ mode: "any", gates: [] });
  assert.ok(!v.ok);
  assert.match(v.error!, /at least one gate/);
});

test("two DIFFERENT badges are not a duplicate — mixed-source groups are legitimate", async () => {
  // This one must get PAST the duplicate check to reach the per-gate binding
  // work, so it is asserted on the reason rather than on ok: a mixed group is
  // allowed by design, and only fails here because the fixtures point at
  // nothing readable.
  const v = await validatePodGate({
    mode: "any",
    gates: [chainGate(), certGate({ manifestRef: OTHER_BADGE })],
  });
  assert.ok(!v.ok);
  assert.doesNotMatch(v.error!, /listed twice/);
});
