/**
 * Reading a published report from storage (#312) — the path the verification
 * page falls back to when the counter cannot be reached.
 *
 * The properties that decide whether the fallback is honest:
 *
 *   - It reads the address the PUBLIC RULES give, not one it was told. Every
 *     step (topic from format+subject, identifier from topic+version, address
 *     from identifier+owner) is derivable by a stranger, which is the entire
 *     claim "you can read this without asking us".
 *   - A report about another subject or another statement type is refused. The
 *     topic already binds both, so this only fires if the indexer published the
 *     wrong thing at its own address — and rendering that under this coaster's
 *     name would be the most convincing wrong number the page could show.
 *   - Every failure is `null`, never a throw and never an accusation. A chunk
 *     that has not settled looks exactly like one that was never written.
 *   - When BOTH the counter and its published copy fail, the error the reader
 *     is shown is the COUNTER's — the fallback going quiet is not the thing
 *     they can act on.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SOCIAL_INDEXER_ADDRESS,
  calculateSocAddress,
  contentFeedSocIdentifier,
  encodeSpan,
  evidenceReport,
  evidenceReportTopic,
  versionedSocIdentifier,
  type CarriedEvidenceLeaf,
  type Hex0x,
} from "@woco/shared";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { readPublishedReport } from "../src/lib/credits/published-report.js";
import { RITA_SUBJECT } from "@woco/shared";

const CREDIT_FORMAT = "woco.credit.v1";
const GATEWAY = "https://gateway.example";
const OWNER = `0x${"11".repeat(20)}` as Hex0x;
const HOLDER = "aa".repeat(32);

function leaf(total = 109): CarriedEvidenceLeaf {
  return {
    holder: HOLDER,
    feedOwner: OWNER,
    seq: 4,
    version: 0,
    band: 0,
    digest: `0x${"dd".repeat(32)}` as Hex0x,
    total,
  };
}

function parseLeaf(v: unknown): CarriedEvidenceLeaf | null {
  if (v === null || typeof v !== "object") return null;
  const l = v as Record<string, unknown>;
  if (typeof l.holder !== "string" || typeof l.feedOwner !== "string") return null;
  if (typeof l.total !== "number" || typeof l.seq !== "number" || typeof l.version !== "number") return null;
  if (typeof l.digest !== "string") return null;
  return l as unknown as CarriedEvidenceLeaf;
}

function reportBytes(subject: Hex0x, statementFormat = CREDIT_FORMAT, total = 109): Uint8Array {
  const report = evidenceReport<CarriedEvidenceLeaf>({
    manifest: {
      format: "woco.evidence.v1",
      statementFormat,
      subject,
      participants: [OWNER],
      leaves: [leaf(total)],
      count: total,
    },
    unreadable: [],
    equivocations: [],
    publishedAt: 1_760_000_000_000,
  });
  return new TextEncoder().encode(JSON.stringify(report));
}

/** A stored SOC as the gateway serves it: identifier ‖ signature ‖ span ‖ payload. */
function storedSoc(identifier: Uint8Array, payload: Uint8Array): Uint8Array {
  const span = encodeSpan(payload.length);
  const out = new Uint8Array(32 + 65 + 8 + payload.length);
  out.set(identifier, 0);
  out.set(new Uint8Array(65).fill(7), 32); // signature: never checked on this path
  out.set(span, 97);
  out.set(payload, 105);
  return out;
}

/** Serves exactly the addresses it was given; 404 for everything else. */
function gateway(chunks: Map<string, Uint8Array>, override?: (url: string) => Response | null) {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    const forced = override?.(u);
    if (forced) return forced;
    const addr = u.split("/chunks/")[1] ?? "";
    const bytes = chunks.get(addr);
    if (!bytes) return new Response(null, { status: 404 });
    return new Response(bytes, { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** The address the public rules put version `v` of a subject's report at. */
function addressFor(subject: Hex0x, indexer: Hex0x, v: number, statementFormat = CREDIT_FORMAT): string {
  const base = contentFeedSocIdentifier(evidenceReportTopic(statementFormat, subject));
  const identifier = versionedSocIdentifier(base, v);
  return bytesToHex(calculateSocAddress(identifier, hexToBytes(indexer.replace(/^0x/, ""))));
}

function identifierFor(subject: Hex0x, v: number, statementFormat = CREDIT_FORMAT): Uint8Array {
  return versionedSocIdentifier(contentFeedSocIdentifier(evidenceReportTopic(statementFormat, subject)), v);
}

test("a published report is found at the address the public rules give", async () => {
  const subject = RITA_SUBJECT;
  const chunks = new Map([
    [addressFor(subject, SOCIAL_INDEXER_ADDRESS, 0), storedSoc(identifierFor(subject, 0), reportBytes(subject))],
  ]);
  const gw = gateway(chunks);

  const report = await readPublishedReport(subject, CREDIT_FORMAT, parseLeaf, {
    gateway: GATEWAY,
    fetchImpl: gw.impl,
  });

  assert.ok(report);
  assert.equal(report.manifest.count, 109);
  assert.equal(report.manifest.leaves[0]!.total, 109);
  assert.equal(report.publishedAt, 1_760_000_000_000);
  // Nothing but the gateway was consulted — no counter, no API.
  assert.ok(gw.calls.every((c) => c.startsWith(GATEWAY)));
});

test("the newest version wins", async () => {
  const subject = RITA_SUBJECT;
  const chunks = new Map([
    [addressFor(subject, SOCIAL_INDEXER_ADDRESS, 0), storedSoc(identifierFor(subject, 0), reportBytes(subject, CREDIT_FORMAT, 100))],
    [addressFor(subject, SOCIAL_INDEXER_ADDRESS, 1), storedSoc(identifierFor(subject, 1), reportBytes(subject, CREDIT_FORMAT, 109))],
  ]);
  const report = await readPublishedReport(subject, CREDIT_FORMAT, parseLeaf, {
    gateway: GATEWAY,
    fetchImpl: gateway(chunks).impl,
  });
  assert.equal(report?.manifest.count, 109);
});

test("nothing published reads as nothing, not as an error", async () => {
  const report = await readPublishedReport(RITA_SUBJECT, CREDIT_FORMAT, parseLeaf, {
    gateway: GATEWAY,
    fetchImpl: gateway(new Map()).impl,
  });
  assert.equal(report, null);
});

test("a gateway that refuses or fails reads as nothing, and never throws", async () => {
  for (const status of [403, 500, 502]) {
    const report = await readPublishedReport(RITA_SUBJECT, CREDIT_FORMAT, parseLeaf, {
      gateway: GATEWAY,
      fetchImpl: gateway(new Map(), () => new Response(null, { status })).impl,
    });
    assert.equal(report, null, `HTTP ${status}`);
  }

  const thrower = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  assert.equal(
    await readPublishedReport(RITA_SUBJECT, CREDIT_FORMAT, parseLeaf, { gateway: GATEWAY, fetchImpl: thrower }),
    null,
  );
});

test("a report about a DIFFERENT subject at this address is refused", async () => {
  // Only reachable if the indexer published the wrong thing under its own key.
  // Rendering it would put another coaster's number under this coaster's name.
  const subject = RITA_SUBJECT;
  const other = `0x${"cc".repeat(32)}` as Hex0x;
  const chunks = new Map([
    [addressFor(subject, SOCIAL_INDEXER_ADDRESS, 0), storedSoc(identifierFor(subject, 0), reportBytes(other))],
  ]);
  assert.equal(
    await readPublishedReport(subject, CREDIT_FORMAT, parseLeaf, { gateway: GATEWAY, fetchImpl: gateway(chunks).impl }),
    null,
  );
});

test("a report about a different statement type at this address is refused", async () => {
  const subject = RITA_SUBJECT;
  const chunks = new Map([
    [
      addressFor(subject, SOCIAL_INDEXER_ADDRESS, 0),
      storedSoc(identifierFor(subject, 0), reportBytes(subject, "woco.like.v1")),
    ],
  ]);
  assert.equal(
    await readPublishedReport(subject, CREDIT_FORMAT, parseLeaf, { gateway: GATEWAY, fetchImpl: gateway(chunks).impl }),
    null,
  );
});

test("bytes that are not a report are refused rather than half-read", async () => {
  const subject = RITA_SUBJECT;
  for (const payload of ["not json at all", JSON.stringify({ format: "woco.evidence.v1", count: 109 })]) {
    const chunks = new Map([
      [
        addressFor(subject, SOCIAL_INDEXER_ADDRESS, 0),
        storedSoc(identifierFor(subject, 0), new TextEncoder().encode(payload)),
      ],
    ]);
    assert.equal(
      await readPublishedReport(subject, CREDIT_FORMAT, parseLeaf, { gateway: GATEWAY, fetchImpl: gateway(chunks).impl }),
      null,
      payload.slice(0, 20),
    );
  }
});

test("a different indexer's report is read from a different address", async () => {
  // Whose report you read is a choice of ADDRESS, with no coordination and no
  // permission — the permissionless-indexer model, seen from the reader's side.
  const subject = RITA_SUBJECT;
  const other = `0x${"99".repeat(20)}` as Hex0x;
  const chunks = new Map([
    [addressFor(subject, other, 0), storedSoc(identifierFor(subject, 0), reportBytes(subject, CREDIT_FORMAT, 42))],
  ]);
  const gw = gateway(chunks);

  assert.equal(await readPublishedReport(subject, CREDIT_FORMAT, parseLeaf, { gateway: GATEWAY, fetchImpl: gw.impl }), null);
  const mine = await readPublishedReport(subject, CREDIT_FORMAT, parseLeaf, {
    indexer: other,
    gateway: GATEWAY,
    fetchImpl: gw.impl,
  });
  assert.equal(mine?.manifest.count, 42);
});

test("trailing padding does not stop the report parsing", async () => {
  // Feed payloads are padded; the JSON has to survive it.
  const subject = RITA_SUBJECT;
  const padded = new Uint8Array(reportBytes(subject).length + 16);
  padded.set(reportBytes(subject));
  const chunks = new Map([[addressFor(subject, SOCIAL_INDEXER_ADDRESS, 0), storedSoc(identifierFor(subject, 0), padded)]]);
  const report = await readPublishedReport(subject, CREDIT_FORMAT, parseLeaf, {
    gateway: GATEWAY,
    fetchImpl: gateway(chunks).impl,
  });
  assert.equal(report?.manifest.count, 109);
});

// ---------------------------------------------------------------------------
// The fallback, seen from the page
// ---------------------------------------------------------------------------

test("an unreachable counter falls back to its published report, and says so", async () => {
  const { fetchVerifyReport, resolveCoaster } = await import("../src/lib/credits/verify-report.js");
  const coaster = resolveCoaster(RITA_SUBJECT)!;
  const chunks = new Map([
    [
      addressFor(RITA_SUBJECT, SOCIAL_INDEXER_ADDRESS, 0),
      storedSoc(identifierFor(RITA_SUBJECT, 0), reportBytes(RITA_SUBJECT)),
    ],
  ]);

  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    // Everything that is not a chunk read IS the counter, and the counter is down.
    if (!u.includes("/chunks/")) throw new Error("counter unreachable");
    const bytes = chunks.get(u.split("/chunks/")[1] ?? "");
    return bytes ? new Response(bytes, { status: 200 }) : new Response(null, { status: 404 });
  }) as unknown as typeof fetch;

  try {
    const report = await fetchVerifyReport(coaster, { base: "https://counter.example" });
    assert.equal(report.sources.via, "published");
    assert.equal(report.reconciliation.recounted, 109);
    assert.ok(report.sources.feed);
    // The page must be able to name where it read, or "check it yourself" is
    // an instruction with no address in it.
    assert.equal(report.sources.feed.indexer, SOCIAL_INDEXER_ADDRESS);
  } finally {
    globalThis.fetch = real;
  }
});

test("when both the counter and its published copy are silent, the COUNTER's failure is what surfaces", async () => {
  // The fallback going quiet is not the thing a reader can act on, and
  // "nothing is published" would send them looking for the wrong problem.
  const { fetchVerifyReport, resolveCoaster } = await import("../src/lib/credits/verify-report.js");
  const coaster = resolveCoaster(RITA_SUBJECT)!;

  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    if (!String(url).includes("/chunks/")) throw new Error("counter unreachable");
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;

  try {
    await assert.rejects(() => fetchVerifyReport(coaster, { base: "https://counter.example" }), /counter unreachable/);
  } finally {
    globalThis.fetch = real;
  }
});
