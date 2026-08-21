/**
 * Which PODs can gate, and what gate object a selection produces.
 *
 * Extracted from `PodGateEditor.svelte` because that editor is mounted on the
 * LIVE TICKET SALES path (`TicketSeriesEditor`) and on the shop catalogue, and
 * a component cannot be unit-tested here. The chain arm's behaviour must be
 * provable across this slice, not read.
 */

import type { PodDirectoryEntry, PodGate } from "@woco/shared";

/** Why a POD the organiser owns cannot be used as a gate right now. */
export type NotGateableReason =
  /** Chain-sourced but never registered — no coordinates to read holdings with. */
  | "unregistered"
  /**
   * A certificate badge. Gateable in principle and NOT yet in practice: see
   * {@link partitionGateable}.
   */
  | "cert-not-live";

export interface GateablePartition {
  /** Selectable now. Chain-sourced, registered, both coordinates present. */
  gateable: PodDirectoryEntry[];
  /** Shown, explained, and NOT selectable. */
  blocked: Array<{ pod: PodDirectoryEntry; reason: NotGateableReason }>;
}

/**
 * Split a creator's PODs into what can gate and what cannot.
 *
 * CERTIFICATE BADGES ARE SHOWN, DISABLED — and the condition is not "has it
 * issued anything yet". It is that the PRESENTATION path does not exist:
 * `GateEvidence` is defined and threaded through `checkPodGate`, but no claim
 * route anywhere constructs one, because the challenge round trip is specified
 * and unbuilt. `resolveHolding` therefore returns count 0 for every certificate
 * gate, and a certificate gate with an `always` window on a ticket series is a
 * one-click LIVE PURCHASE OUTAGE — every buyer refused with "proved with a
 * certificate you have not presented yet".
 *
 * Slice 2 recorded the rule as "not until certificates can be issued". Issuing
 * is what this slice ships, so the rule is restated at its real boundary: not
 * until a certificate can be PRESENTED. When the holder slice lands, a
 * zero-issued certificate badge should become selectable like a zero-claimed
 * chain badge is today — the organiser controls that, and warning is enough.
 *
 * They are shown rather than filtered out because the previous filter
 * (`p.eventId && p.chainId`) made them vanish, and an organiser who has just
 * minted one reads invisibility as a bug — the same silent-drop shape this rail
 * keeps producing.
 */
export function partitionGateable(pods: readonly PodDirectoryEntry[]): GateablePartition {
  const gateable: PodDirectoryEntry[] = [];
  const blocked: GateablePartition["blocked"] = [];
  for (const p of pods) {
    if (p.certLogOwner) blocked.push({ pod: p, reason: "cert-not-live" });
    else if (p.eventId && p.chainId) gateable.push(p);
    else blocked.push({ pod: p, reason: "unregistered" });
  }
  return { gateable, blocked };
}

/** Human copy for a blocked row. Display only — never a trust statement. */
export function notGateableLabel(reason: NotGateableReason): string {
  return reason === "cert-not-live"
    ? "Can't gate yet — certificate check-in isn't live"
    : "Not registered on-chain yet";
}

/**
 * Build the gate list for a selection.
 *
 * BYTE-IDENTICAL to what this editor emitted before the certificate rail
 * existed, and deliberately so: it emits `ChainPodGate` and nothing else. A
 * `CertPodGate` cannot be produced here at all, which is the structural version
 * of the rule above — a certificate badge is not merely unselectable in the UI,
 * it has no path to a stored gate through this function.
 *
 * `selectedRefs` is filtered against `gateable`, so a ref that is stale, or was
 * selected before a reload, or names a blocked POD, drops out rather than
 * emitting a gate with missing coordinates.
 */
export function buildChainGates(
  selectedRefs: readonly string[],
  gateable: readonly PodDirectoryEntry[],
): PodGate[] {
  return selectedRefs.flatMap((ref) => {
    const entry = gateable.find((p) => p.manifestRef === ref);
    if (!entry?.eventId || !entry?.chainId) return [];
    return [{
      manifestRef: entry.manifestRef,
      onChainEventId: entry.eventId,
      chainId: entry.chainId,
      podName: entry.name,
    }];
  });
}
