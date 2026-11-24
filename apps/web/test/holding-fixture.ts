/**
 * Shared by the holding tests: an order's receipt box as fulfilment makes one, and an
 * in-memory stand-in for the `holding` feeds with the semantics that matter here - a
 * version is written once and keeps its first bytes (a second writer is `superseded`),
 * reads can be made to fail, and writes can be made to go unconfirmed.
 */
import { holdingAnswerKey, holdingHolderKey, holdingNk, holdingNkCommit, holdingPickupId, holdingPickupKem } from "@woco/shared/holding/derive";
import { signTicketHolding } from "@woco/shared/holding/receipt";
import { holdingBoxSealContext, sealBoxJson } from "@woco/shared/crypto/sealed-box";
import type { HoldingBoxV1 } from "@woco/shared/holding/box";
import type { HoldingFeedIO } from "../src/lib/holding/account-copy.ts";
import type { ContentFeedResult, ContentFeedWriteBase } from "../src/lib/swarm/content-feed.ts";
import { FEED_ROUTES } from "../src/lib/swarm/gateways.ts";

export const TARGET = { chainId: 42161, ledger: "0x5cd8394ef7a4e50403ff72d6addd4582332a6050" };
export const EVENT_ID = `0x${"ab".repeat(32)}`;

export function secret(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

export function makeBox(r: Uint8Array, n: number, firstSlot = 6, seriesId = "series-1"): HoldingBoxV1 {
  const nkCommit = holdingNkCommit(holdingNk(r));
  return {
    v: 1,
    receipts: Array.from({ length: n }, (_, i) => {
      const slot = firstSlot + i;
      const holding = { eventId: EVENT_ID, slot, holder: holdingHolderKey(r, i).address, answerKey: holdingAnswerKey(r, i).address, nkCommit };
      return {
        ...holding,
        chainId: TARGET.chainId,
        ledger: TARGET.ledger,
        wocoEventId: "evt-1",
        seriesId,
        edition: slot + 1,
        sig: signTicketHolding(TARGET, holding, new Uint8Array(32).fill((slot % 200) + 7)),
      };
    }),
  };
}

export function sealFor(r: Uint8Array, box: unknown) {
  return sealBoxJson(holdingPickupKem(r).publicKey, box, holdingBoxSealContext(holdingPickupId(r)));
}

export interface FakeFeeds {
  io: HoldingFeedIO;
  /** owner|topic -> the JSON text at each version. */
  feeds: Map<string, string[]>;
  writes: { owner: string; topic: string; version: number }[];
  /** Topics whose reads answer "unavailable". */
  failReads: Set<string>;
  /** Topics whose given version exists and will never read: "unavailable" with `unusableAt`. */
  spent: Map<string, number>;
  /** Topics whose scan stops one version short of the head: found, `scanClean` false. */
  dirty: Set<string>;
  /** Every read, by topic. */
  reads: string[];
  /** Writes after this many accepted go unconfirmed (the bytes still land). */
  unconfirmAfter: number;
  /** Called before a write lands: put another writer's bytes at the same version to race it. */
  beforeWrite?: (owner: string, topic: string, version: number) => void;
  latest(owner: string, topic: string): unknown;
  /** Another writer's bytes at `version`. */
  put(owner: string, topic: string, version: number, value: unknown): void;
}

export function fakeFeeds(): FakeFeeds {
  const feeds = new Map<string, string[]>();
  const writes: FakeFeeds["writes"] = [];
  const key = (owner: string, topic: string) => `${owner.toLowerCase().replace(/^0x/, "")}|${topic}`;
  const f: FakeFeeds = {
    feeds,
    writes,
    failReads: new Set(),
    spent: new Map(),
    dirty: new Set(),
    reads: [],
    unconfirmAfter: Infinity,
    latest: (owner, topic) => {
      const v = feeds.get(key(owner, topic));
      return v?.length ? JSON.parse(v[v.length - 1]!) : undefined;
    },
    put: (owner, topic, version, value) => {
      const list = feeds.get(key(owner, topic)) ?? [];
      list[version] = JSON.stringify(value);
      feeds.set(key(owner, topic), list);
    },
    io: undefined as unknown as HoldingFeedIO,
  };
  const read = (owner: string, topic: string): ContentFeedResult<unknown> => {
    f.reads.push(topic);
    if (f.failReads.has(topic)) return { status: "unavailable", reason: "test" };
    const spentAt = f.spent.get(topic);
    if (spentAt !== undefined) return { status: "unavailable", reason: "spent", unusableAt: spentAt };
    const v = feeds.get(key(owner, topic));
    if (!v?.length) return { status: "absent" };
    if (f.dirty.has(topic)) {
      // The probe past this version could not be answered: it may not be the head.
      const at = Math.max(0, v.length - 2);
      return { status: "found", value: JSON.parse(v[at]!), version: at, scanClean: false };
    }
    return { status: "found", value: JSON.parse(v[v.length - 1]!), version: v.length - 1, scanClean: true };
  };
  const base = (owner: string, topic: string): ContentFeedWriteBase<unknown> => {
    const r = read(owner, topic);
    // As `nextVersionAfter`: a spent version is written past.
    const nextVersion =
      r.status === "absent" ? 0
      : r.status === "found" ? (r.scanClean ? r.version + 1 : null)
      : r.unusableAt !== undefined ? r.unusableAt + 1 : null;
    return { read: r, nextVersion, owner: owner.toLowerCase().replace(/^0x/, ""), topic, route: FEED_ROUTES.holding };
  };
  f.io = {
    readBase: async (owner, topic) => base(owner, topic),
    read: async (owner, topic) => read(owner, topic),
    write: async ({ signer, topic, base: first, build }) => {
      let b: ContentFeedWriteBase<unknown> | null = first;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!b || b.nextVersion === null) b = base(signer.address, topic);
        if (b.nextVersion === null) throw new Error("inconclusive");
        const data = await build(b.read);
        const version = b.nextVersion;
        f.beforeWrite?.(signer.address, topic, version);
        const list = feeds.get(key(signer.address, topic)) ?? [];
        feeds.set(key(signer.address, topic), list);
        if (list[version] !== undefined) {
          // Taken: the chunk keeps its first bytes, and the read-back says so.
          b = null;
          continue;
        }
        list[version] = JSON.stringify(data);
        writes.push({ owner: signer.address, topic, version });
        return writes.length > f.unconfirmAfter ? "unconfirmed" : "verified";
      }
      throw new Error("superseded three times");
    },
  };
  return f;
}
