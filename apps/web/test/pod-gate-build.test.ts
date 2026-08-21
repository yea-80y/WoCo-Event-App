/**
 * The gate editor's logic, pinned — because that editor is mounted on the LIVE
 * TICKET SALES path (`TicketSeriesEditor`) and on the shop catalogue.
 *
 * Two properties matter and neither is visible by reading the component:
 *
 * 1. the CHAIN arm emits exactly what it emitted before the certificate rail
 *    existed, field for field;
 * 2. a certificate badge has NO path to a stored gate through this code — not
 *    merely an unselectable one in the UI.
 *
 * (2) is not caution. `GateEvidence` is defined and threaded through
 * `checkPodGate`, but nothing in the codebase constructs one, so `resolveHolding`
 * returns count 0 for every certificate gate. A certificate gate with an
 * `always` window on a ticket series is a one-click live purchase outage.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { PodDirectoryEntry } from "@woco/shared";
import {
  partitionGateable,
  buildChainGates,
  notGateableLabel,
} from "../src/lib/components/pod/gate-build.js";

function pod(over: Partial<PodDirectoryEntry> = {}): PodDirectoryEntry {
  return {
    manifestRef: `0x${"11".repeat(32)}`,
    kind: "badge",
    name: "Founding Member",
    supply: 100,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    ...over,
  } as PodDirectoryEntry;
}

const chainPod = pod({ eventId: `0x${"aa".repeat(32)}`, chainId: 421614 });
const certPod = pod({
  manifestRef: `0x${"22".repeat(32)}`,
  name: "Century Rider",
  certLogOwner: "0x3333333333333333333333333333333333333333",
  swarmManifestRef: "ab".repeat(32),
});
const unregistered = pod({ manifestRef: `0x${"33".repeat(32)}`, name: "Half-minted" });

// ---------------------------------------------------------------------------
// What can gate
// ---------------------------------------------------------------------------

test("a registered chain POD is gateable", () => {
  const { gateable, blocked } = partitionGateable([chainPod]);
  assert.equal(gateable.length, 1);
  assert.equal(blocked.length, 0);
});

test("a certificate badge is BLOCKED, not gateable — no presentation path exists", () => {
  const { gateable, blocked } = partitionGateable([certPod]);
  assert.equal(gateable.length, 0);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.reason, "cert-not-live");
});

test("a certificate badge is SHOWN rather than filtered away", () => {
  // The old filter (`p.eventId && p.chainId`) made them vanish. An organiser
  // who has just minted one reads invisibility as a bug — and a picker that
  // silently drops an entry looks exactly like one with nothing to show.
  const { blocked } = partitionGateable([chainPod, certPod]);
  assert.deepEqual(blocked.map((b) => b.pod.name), ["Century Rider"]);
});

test("blockedness does not depend on how many certificates were issued", () => {
  // The condition is the missing presentation path, NOT zero issuance. A
  // certificate badge with holders is still unpassable today.
  const issued = { ...certPod, issuedCount: 40 };
  assert.equal(partitionGateable([issued]).blocked[0]!.reason, "cert-not-live");
});

test("an unregistered chain POD is blocked for a DIFFERENT, honest reason", () => {
  const { blocked } = partitionGateable([unregistered]);
  assert.equal(blocked[0]!.reason, "unregistered");
  assert.notEqual(notGateableLabel("unregistered"), notGateableLabel("cert-not-live"));
});

test("a cert badge missing chain coordinates is not mistaken for unregistered", () => {
  // Order matters: certLogOwner is checked FIRST. A certificate badge has no
  // eventId/chainId by construction, so the unregistered branch would otherwise
  // claim it and tell the organiser to wait for a chain registration that is
  // never coming.
  assert.equal(partitionGateable([certPod]).blocked[0]!.reason, "cert-not-live");
});

test("every POD lands in exactly one bucket — none is lost", () => {
  const all = [chainPod, certPod, unregistered];
  const { gateable, blocked } = partitionGateable(all);
  assert.equal(gateable.length + blocked.length, all.length);
});

// ---------------------------------------------------------------------------
// What a selection emits
// ---------------------------------------------------------------------------

test("CHAIN ARM UNCHANGED: the emitted gate is field-for-field what it always was", () => {
  const gates = buildChainGates([chainPod.manifestRef], [chainPod]);
  assert.equal(gates.length, 1);
  assert.deepEqual(gates[0], {
    manifestRef: chainPod.manifestRef,
    onChainEventId: chainPod.eventId,
    chainId: chainPod.chainId,
    podName: chainPod.name,
  });
  assert.equal(
    "holdingSource" in gates[0]!,
    false,
    "absent holdingSource IS the chain discriminant — writing one would change stored bytes",
  );
});

test("a certificate badge cannot be emitted even if its ref is selected", () => {
  // The structural half of the rule: not merely unselectable in the UI.
  const gates = buildChainGates([certPod.manifestRef], partitionGateable([certPod]).gateable);
  assert.deepEqual(gates, []);
});

test("a cert ref smuggled into the gateable list still cannot produce a cert gate", () => {
  // Belt and braces: even given a corrupted list, the builder has no branch
  // that emits `holdingSource: "pod-cert"`.
  const gates = buildChainGates([certPod.manifestRef], [certPod]);
  assert.deepEqual(gates, [], "no chain coordinates, so nothing is emitted");
});

test("a stale ref naming no known POD drops out rather than emitting a broken gate", () => {
  const gates = buildChainGates([`0x${"ff".repeat(32)}`], [chainPod]);
  assert.deepEqual(gates, []);
});

test("selection order is preserved for multi-POD gates", () => {
  const second = pod({
    manifestRef: `0x${"44".repeat(32)}`,
    name: "Second",
    eventId: `0x${"bb".repeat(32)}`,
    chainId: 421614,
  });
  const gates = buildChainGates([second.manifestRef, chainPod.manifestRef], [chainPod, second]);
  assert.deepEqual(gates.map((g) => g.podName), ["Second", "Founding Member"]);
});
