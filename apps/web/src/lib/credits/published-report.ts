/**
 * Reading the report an indexer PUBLISHED, without asking the indexer anything.
 *
 * The counting page normally asks the counter for its working. This is the
 * other way in: the same working, written to a single-owner feed at an address
 * derived from the subject, so a browser computes where it is and fetches it
 * from storage. No API, no permission, and no way for the answer to be tailored
 * to one reader — a feed version is the same bytes for whoever reads it.
 *
 * DELIBERATELY LEAN, like `spot-check.ts` next door. The verification page is
 * its own build entry with no auth stack, and it must stay that way, so this
 * talks to a storage gateway with `fetch` and derives every address from shared
 * rules rather than importing the app's Swarm layer.
 *
 * NEVER THROWS, NEVER ACCUSES. Every failure — unreachable gateway, a chunk
 * that has not settled, bytes that are not a report — is `null`. A page that
 * cannot read the published copy should say the counter could not be reached,
 * not invent a second failure to describe.
 */

import {
  SOCIAL_INDEXER_ADDRESS,
  calculateSocAddress,
  evidenceReportTopic,
  parseEvidenceReportV1,
  readVersionedContentFeed,
  splitStoredSoc,
  type EvidenceReportV1,
  type Hex0x,
  type SocChunkProbe,
} from "@woco/shared";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import { WOCO_GATEWAY_URL } from "../swarm/gateways.js";

/** Long enough for a cold network search; short enough that a stuck gateway
 *  does not hold the page on "checking…" for the length of a stream segment. */
const READ_TIMEOUT_MS = 10_000;

/**
 * A chunk probe over a storage gateway.
 *
 * The three outcomes are kept apart because the shared feed reader depends on
 * it: `absent` ends a version scan, `unavailable` marks the scan unreliable so
 * "nothing here" is never concluded from a gateway having a bad minute. 403 is
 * `unavailable`, not absence — this gateway serves chunks it has been told
 * about, and a listing lag looks exactly like a chunk that was never written.
 */
function gatewayProbe(owner: Uint8Array, gateway: string, doFetch: typeof fetch, signal?: AbortSignal): SocChunkProbe {
  return async (identifier) => {
    const address = bytesToHex(calculateSocAddress(identifier, owner));
    let raw: Uint8Array;
    try {
      const resp = await doFetch(`${gateway}/chunks/${address}`, {
        signal: signal ?? AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      if (resp.status === 404) return { status: "absent" };
      if (!resp.ok) return { status: "unavailable", reason: `gateway HTTP ${resp.status}` };
      raw = new Uint8Array(await resp.arrayBuffer());
    } catch {
      return { status: "unavailable", reason: "gateway unreachable" };
    }
    const chunk = splitStoredSoc(raw);
    if (!chunk) return { status: "unavailable", reason: "not a stored chunk" };
    // The identifier is not re-checked against the request: the address was
    // DERIVED from it, so a mismatch is not reachable without the gateway
    // serving a different address than the one asked for.
    return { status: "found", bytes: chunk.payload };
  };
}

/**
 * The latest published report for a subject, or null.
 *
 * `parseLeaf` is injected because the two tally families carry different
 * leaves, and their parsers live with the surfaces that render them. This
 * module's job is finding the bytes, not deciding what a leaf is.
 *
 * `version` is a lower bound the caller may know from elsewhere (the counter
 * returns one alongside a served manifest). Absent, the scan starts at zero,
 * which costs reads and never correctness.
 */
export async function readPublishedReport<L>(
  subject: Hex0x,
  statementFormat: string,
  parseLeaf: (leaf: unknown) => L | null,
  opts: {
    indexer?: Hex0x;
    version?: number;
    gateway?: string;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  } = {},
): Promise<EvidenceReportV1<L> | null> {
  const indexer = opts.indexer ?? SOCIAL_INDEXER_ADDRESS;
  const gateway = opts.gateway ?? (import.meta.env?.VITE_GATEWAY_URL || WOCO_GATEWAY_URL);
  const doFetch = opts.fetchImpl ?? fetch;

  let owner: Uint8Array;
  let topic: string;
  try {
    owner = hexToBytes(indexer.replace(/^0x/, ""));
    topic = evidenceReportTopic(statementFormat, subject);
  } catch {
    return null;
  }

  const read = gatewayProbe(owner, gateway, doFetch, opts.signal);
  const res = await readVersionedContentFeed(read, topic, opts.version ?? 0);
  if (res.status !== "found") return null;

  let parsed: unknown;
  try {
    // Trailing NULs are padding, not content — the same trim the entry reader
    // next door applies.
    parsed = JSON.parse(new TextDecoder().decode(res.bytes).replace(/\0+$/, ""));
  } catch {
    return null;
  }

  const report = parseEvidenceReportV1(parsed, parseLeaf);
  if (!report) return null;
  // The topic already binds both — it derives from the subject and the format
  // salts it — so this only fires if the indexer published the wrong thing at
  // its own address. Checked because a report answering a different question,
  // rendered under this subject's name, is the most convincing wrong number
  // this page could show.
  if (report.manifest.statementFormat !== statementFormat) return null;
  if (report.manifest.subject.toLowerCase() !== subject.toLowerCase()) return null;
  return report;
}
