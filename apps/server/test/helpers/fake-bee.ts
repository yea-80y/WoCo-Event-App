/**
 * A fake bee for directory tests: one SOC store holding real signed chunks
 * (identifier ‖ signature ‖ span ‖ payload), first write wins at an address (bee
 * 2.7+ keeps the old bytes and still answers 201), `GET /feeds` walking the
 * store the way bee's sequence lookup does, and the production error shapes of
 * bee 2.8's one-minute skip list on demand: `GET /feeds` 404 "lookup at failed",
 * `GET /chunks` 500 "read chunk failed". Uploads are pushes, not retrievals, so
 * the skip list never refuses them; `uploadFails` makes a topic's uploads 500
 * for tests of a write that fails part-way.
 *
 * Extracted from the site-directory test (#944) so every first-write directory
 * test runs against the same bee. Start it before importing any server module:
 * `config/swarm.ts` reads BEE_URL at import.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { FeedIndex } from "@ethersphere/bee-js";
import { Binary } from "cafe-utility";
import { calculateSocAddress } from "@woco/shared";

const hex = (b: Uint8Array) => Binary.uint8ArrayToHex(b);
const unhex = (h: string) => Binary.hexToUint8Array(h);
const PAYLOAD_OFFSET = 32 + 65 + 8;
/** How many indexes of a topic `skipTopic` / `uploadFails` cover. */
const COVERED_INDEXES = 32n;

export function socIdentifier(topicHex: string, index: bigint): string {
  return hex(Binary.keccak256(Binary.concatBytes(unhex(topicHex), FeedIndex.fromBigInt(index).toUint8Array())));
}

export function socAddress(owner: string, topicHex: string, index: bigint): string {
  return hex(calculateSocAddress(unhex(socIdentifier(topicHex, index)), unhex(owner)));
}

export interface FakeBee {
  url: string;
  /** SOC address -> stored chunk. */
  chunks: Map<string, Uint8Array>;
  /** Every SOC address an upload was accepted for, in order. */
  posted: string[];
  net: {
    /** Every feed lookup answers 404 "lookup at failed". */
    lookupFailed: boolean;
    /** Every chunk read answers 500 "read chunk failed". */
    chunks500: boolean;
    feedLookups: number;
    chunkReads: number;
    /** Hold the next lookup of this topic: answer computed on arrival, sent on release. */
    holdOnce: null | { topicHex: string; arrived: () => void; release: Promise<void> };
  };
  /** Whole-node skip list (both answers). */
  skipListed(on: boolean): void;
  /** Skip-list one topic of one owner: its lookups and its chunks. */
  skipTopic(owner: string, topicHex: string, on: boolean): void;
  /** Our bee behind a write: lookups of the topic answer "no update found" though its chunks are there. */
  lagTopic(owner: string, topicHex: string, on: boolean): void;
  /** Make uploads to one topic of one owner answer 500. */
  uploadFails(owner: string, topicHex: string, on: boolean): void;
  /** Lookups of one topic answered so far. */
  lookupsOf(topicHex: string): number;
  /** Payloads written to `owner`'s `topicHex`, oldest first. */
  payloads(owner: string, topicHex: string): Uint8Array[];
  reset(): void;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(parts))));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

export async function startFakeBee(): Promise<FakeBee> {
  const chunks = new Map<string, Uint8Array>();
  const posted: FakeBee["posted"] = [];
  const net: FakeBee["net"] = { lookupFailed: false, chunks500: false, feedLookups: 0, chunkReads: 0, holdOnce: null };
  /** Topic keys (`owner/topic`) skip-listed, with the chunk addresses they cover. */
  const skipped = new Map<string, Set<string>>();
  /** Identifier -> topic key, for topics whose uploads fail. */
  const failingUploads = new Map<string, string>();
  const lookups = new Map<string, number>();

  const coveredAddresses = (owner: string, topicHex: string) => {
    const out = new Set<string>();
    for (let i = 0n; i < COVERED_INDEXES; i++) out.add(socAddress(owner, topicHex, i));
    return out;
  };
  const lagging = new Set<string>();
  const isSkippedChunk = (address: string) => [...skipped.values()].some((s) => s.has(address));

  function feedAnswer(owner: string, topicHex: string): (res: ServerResponse) => void {
    if (net.lookupFailed || skipped.has(`${owner}/${topicHex}`)) {
      return (res) => json(res, 404, { code: 404, message: "lookup at failed" });
    }
    if (lagging.has(`${owner}/${topicHex}`)) return (res) => json(res, 404, { code: 404, message: "no update found" });
    let latest = -1n;
    while (chunks.has(socAddress(owner, topicHex, latest + 1n))) latest++;
    if (latest < 0n) return (res) => json(res, 404, { code: 404, message: "no update found" });
    const payload = chunks.get(socAddress(owner, topicHex, latest))!.subarray(PAYLOAD_OFFSET);
    return (res) =>
      res
        .writeHead(200, {
          "Content-Type": "application/octet-stream",
          "swarm-feed-index": FeedIndex.fromBigInt(latest).toHex(),
          "swarm-feed-index-next": FeedIndex.fromBigInt(latest + 1n).toHex(),
        })
        .end(Buffer.from(payload));
  }

  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0]!;
    if (req.method === "POST" && path.startsWith("/soc/")) {
      const url = new URL(req.url ?? "", "http://x");
      const [, , owner, id] = url.pathname.split("/");
      const body = await readBody(req);
      const identifier = id!.toLowerCase();
      if (failingUploads.has(identifier)) return json(res, 500, { code: 500, message: "upload failed" });
      const addr = hex(calculateSocAddress(unhex(identifier), unhex(owner!)));
      posted.push(addr);
      if (!chunks.has(addr)) chunks.set(addr, Binary.concatBytes(unhex(identifier), unhex(url.searchParams.get("sig")!), body));
      return json(res, 201, { reference: addr });
    }
    if (req.method === "GET" && path.startsWith("/chunks/")) {
      net.chunkReads++;
      const addr = path.split("/")[2]!.toLowerCase();
      if (net.chunks500 || isSkippedChunk(addr)) return json(res, 500, { code: 500, message: "read chunk failed" });
      const c = chunks.get(addr);
      if (!c) return json(res, 404, { code: 404, message: "chunk not found" });
      return res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(Buffer.from(c));
    }
    const m = /^\/feeds\/([0-9a-f]{40})\/([0-9a-f]{64})$/i.exec(path);
    if (req.method === "GET" && m) {
      net.feedLookups++;
      const topicHex = m[2]!.toLowerCase();
      lookups.set(topicHex, (lookups.get(topicHex) ?? 0) + 1);
      const answer = feedAnswer(m[1]!.toLowerCase(), topicHex);
      const hold = net.holdOnce;
      if (hold && hold.topicHex === topicHex) {
        net.holdOnce = null;
        hold.arrived();
        await hold.release;
      }
      return answer(res);
    }
    json(res, 404, { code: 404, message: "Not Found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    chunks,
    posted,
    net,
    skipListed(on) {
      net.lookupFailed = on;
      net.chunks500 = on;
    },
    skipTopic(owner, topicHex, on) {
      const key = `${owner.toLowerCase()}/${topicHex.toLowerCase()}`;
      if (on) skipped.set(key, coveredAddresses(owner.toLowerCase(), topicHex.toLowerCase()));
      else skipped.delete(key);
    },
    lagTopic(owner, topicHex, on) {
      const key = `${owner.toLowerCase()}/${topicHex.toLowerCase()}`;
      if (on) lagging.add(key);
      else lagging.delete(key);
    },
    uploadFails(owner, topicHex, on) {
      const key = `${owner.toLowerCase()}/${topicHex.toLowerCase()}`;
      for (let i = 0n; i < COVERED_INDEXES; i++) {
        const id = socIdentifier(topicHex.toLowerCase(), i);
        if (on) failingUploads.set(id, key);
        else failingUploads.delete(id);
      }
    },
    lookupsOf(topicHex) {
      return lookups.get(topicHex.toLowerCase()) ?? 0;
    },
    payloads(owner, topicHex) {
      const out: Uint8Array[] = [];
      for (let i = 0n; ; i++) {
        const c = chunks.get(socAddress(owner.toLowerCase(), topicHex.toLowerCase(), i));
        if (!c) return out;
        out.push(c.subarray(PAYLOAD_OFFSET));
      }
    },
    reset() {
      net.lookupFailed = false;
      net.chunks500 = false;
      net.feedLookups = 0;
      net.chunkReads = 0;
      net.holdOnce = null;
      posted.length = 0;
      skipped.clear();
      lagging.clear();
      failingUploads.clear();
      lookups.clear();
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
