/**
 * Everything a buyer's map reads, straight from Swarm and the chain, plus the one
 * thing only our server knows (seats in someone's hold). docs/SEATING.md decision 6;
 * design per the S3 consult (2026-11-03).
 *
 * What is checked before a seat is drawn:
 *   the series' manifest blob (Swarm, by `swarmManifestRef`)
 *   -> its body's digest must equal the ledger's `manifestRef`, and `isSeated` true
 *   -> the body names the plan (`seatPlan { ref, digest, seats }`)
 *   -> the plan's bytes must hash to that digest and validate in full.
 * So the map draws exactly the plan the chain committed, whatever served the bytes
 * or the event feed says. The money path does not depend on any of this: the server
 * sells only from the plan it pinned at registration.
 *
 * Then a refresh loop: every ~20 s while the page is visible, the words covering
 * what is on screen plus the picked seats (with their nonces, in the same batch),
 * the event's sale state and the live holds; a full re-read every ~2 minutes. Each
 * value keeps the highest L2 block it was read at, so a lagging RPC replica never
 * turns a sold seat back to free.
 */

import { MULTICALL3_ADDRESS, RpcError, decodeAggregate3, encodeAggregate3, ethCall, type ViewCall } from "@woco/shared/chain/multicall";
// By path: `edition/index` also re-exports the Merkle code, which the map never needs.
import { manifestV2Digest } from "@woco/shared/edition/canonical";
import { MAX_SEAT_PLAN_BYTES, initialHeldSeats } from "@woco/shared/seating/plan";
import { seatPlanTemplateOf } from "@woco/shared/seating/template";
import { bandPricesMinor } from "@woco/shared/seating/series";
import { SEAT_WORDS_PER_BATCH, seatBatch, seatWordCount, type SeatBatchRead, type SeatEventRead } from "@woco/shared/seating/chain";
import type { ChainSeats } from "@woco/shared/seating/availability";
import type { SeatStateView } from "@woco/shared/seating/state";
import type { SeriesSeating } from "@woco/shared/event/types";
import { buyerPlan, type BuyerPlan } from "./buyer.js";
import { parsePlan } from "./parse.js";

export interface SeatMapSeries {
  /** The event's id in WoCo (for the holds route). */
  eventId: string;
  seriesId: string;
  /** 0x + 64 hex: the ledger's event id. */
  onChainEventId: string;
  /** The series' manifest blob on Swarm. */
  swarmManifestRef: string;
  /** Band prices from the event feed. */
  seating: SeriesSeating;
}

export interface SeatMapDeps {
  fetch: typeof fetch;
  /** The WoCo gateway (Etherna sends no CORS). */
  gatewayUrl: string;
  rpcUrl: string;
  apiUrl: string;
  /** The ledger2 deployment on the chain `rpcUrl` reaches. */
  ledger: string;
  /**
   * The organiser's held seats and confirmed nonces. Until the seat-state feed is
   * written (S6) this is the plan's own held flags.
   */
  organiserState?: (bp: BuyerPlan) => Promise<SeatStateView>;
  /** Timers and visibility, injectable for tests. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
  visible?: () => boolean;
  random?: () => number;
}

/**
 *   publishing   the plan is not on our gateway yet (an Etherna-stored plan takes minutes)
 *   not-seated   the ledger has no such event, or not a seated one
 *   mismatch     what Swarm served is not what the chain committed (or not a valid plan)
 *   unavailable  the plan could not be fetched just now
 */
export type SeatMapProblem = "publishing" | "not-seated" | "mismatch" | "unavailable";

export interface SeatMapSnapshot {
  /** Null while the chain has not answered: the map draws, nothing can be picked. */
  chain: ChainSeats | null;
  /** Seats in someone's hold, or paid and not yet on the chain (live holds route). */
  onHold: readonly number[];
  /** Our server answered the last holds read. */
  serverOk: boolean;
  /** The last chain read was refused for rate: reads are backing off. */
  slowedDown: boolean;
}

export interface LiveSeatMap {
  plan: BuyerPlan;
  /** Price in minor units by plan band index; null = not sold. */
  bandPrices: (number | null)[];
  organiser: SeatStateView;
  snapshot(): SeatMapSnapshot;
  /** Called after every read that changed anything. Returns an unsubscribe. */
  subscribe(fn: (s: SeatMapSnapshot) => void): () => void;
  /** What to keep fresh: seats on screen and the buyer's picks (their nonces are read too). */
  watch(seats: { onScreen: readonly number[]; picks: readonly number[] }): void;
  /** Read now (after a refused hold, or the page coming back into view). */
  refresh(full?: boolean): Promise<void>;
  start(): void;
  stop(): void;
  /** The chain found the plan is not the committed one after the first draw: stop selling from it. */
  readonly problem: SeatMapProblem | null;
}

const REFRESH_MS = 20_000;
const FULL_EVERY = 6;
const MAX_BACKOFF_MS = 160_000;
const PARALLEL = 3;

async function gatewayBytes(deps: SeatMapDeps, ref: string, max: number): Promise<Uint8Array | SeatMapProblem> {
  let resp: Response;
  try {
    resp = await deps.fetch(`${deps.gatewayUrl.replace(/\/+$/, "")}/bytes/${ref}`);
  } catch {
    return "unavailable";
  }
  // Our gateway answers a chunk it does not (yet) serve with 404, or a tagged 403.
  if (resp.status === 404 || (resp.status === 403 && resp.headers.get("X-Chunk-Gate"))) return "publishing";
  if (!resp.ok) return "unavailable";
  const len = Number(resp.headers.get("content-length") ?? 0);
  if (len > max) return "mismatch";
  const bytes = new Uint8Array(await resp.arrayBuffer());
  return bytes.length > max ? "mismatch" : bytes;
}

/** Run seat batches, at most PARALLEL eth_calls at once. */
async function runBatches(deps: SeatMapDeps, batches: ReturnType<typeof seatBatch>[]): Promise<{ reads: SeatBatchRead[]; rateLimited: boolean }> {
  const reads: SeatBatchRead[] = [];
  let rateLimited = false;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, async () => {
    while (next < batches.length) {
      const b = batches[next++];
      try {
        const call: ViewCall = { target: MULTICALL3_ADDRESS, data: encodeAggregate3(b.calls) };
        reads.push(b.decode(decodeAggregate3(await ethCall(deps.rpcUrl, call, deps.fetch), b.expect)));
      } catch (err) {
        if (err instanceof RpcError && err.rateLimited) rateLimited = true;
      }
    }
  }));
  return { reads, rateLimited };
}

export async function loadSeatMap(series: SeatMapSeries, deps: SeatMapDeps): Promise<{ ok: true; map: LiveSeatMap } | { ok: false; problem: SeatMapProblem }> {
  const eventId = series.onChainEventId.toLowerCase();
  const ledger = deps.ledger.toLowerCase();

  // The manifest and the chain's view of the event, together.
  const firstChain = runBatches(deps, [seatBatch(ledger, eventId, { event: true, words: [], nonceSeats: [] })]);
  const manifestBytes = await gatewayBytes(deps, series.swarmManifestRef, 4 * 1024 * 1024);
  if (typeof manifestBytes === "string") return { ok: false, problem: manifestBytes };
  let body: unknown;
  try {
    body = (JSON.parse(new TextDecoder().decode(manifestBytes)) as { signedManifest?: { body?: unknown } }).signedManifest?.body;
  } catch {
    return { ok: false, problem: "mismatch" };
  }
  let manifestDigest: string;
  try {
    // Never the blob's own `manifestDigestHex`: the digest is recomputed from the body.
    manifestDigest = `0x${Array.from(manifestV2Digest(body as Parameters<typeof manifestV2Digest>[0]), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return { ok: false, problem: "mismatch" };
  }
  const template = seatPlanTemplateOf(body as Parameters<typeof seatPlanTemplateOf>[0]);
  if (!template || template === "invalid") return { ok: false, problem: "mismatch" };

  // The chain's word on the event decides before any plan bytes are fetched.
  let problem: SeatMapProblem | null = null;
  const anchor = (ev: SeatEventRead): SeatMapProblem | null => {
    if (!ev.seated) return "not-seated";
    if (ev.manifestRef.toLowerCase() !== manifestDigest) return "mismatch";
    return null;
  };
  const first = await firstChain;
  const firstRead = first.reads[0];
  if (firstRead?.block != null && firstRead.event === null) return { ok: false, problem: "not-seated" };
  if (firstRead?.event) {
    const p = anchor(firstRead.event);
    if (p) return { ok: false, problem: p };
  }

  const planBytes = await gatewayBytes(deps, template.ref, MAX_SEAT_PLAN_BYTES);
  if (typeof planBytes === "string") return { ok: false, problem: planBytes };
  const plan = await parsePlan(planBytes, template.digest, template.seats);
  if (!plan || plan.seats.length !== template.seats) return { ok: false, problem: "mismatch" };
  const bp = buyerPlan(plan, template.digest);
  const prices = bandPricesMinor(series.seating);
  const bandPrices = plan.bands.map((b) => prices.get(b.id) ?? null);
  const organiser = deps.organiserState ? await deps.organiserState(bp) : { held: initialHeldSeats(plan), confirmed: new Map<number, number>() };

  // ── The live part ───────────────────────────────────────────────────────────
  const nWords = seatWordCount(bp.seats);
  let event: { v: SeatEventRead; b: bigint } | null = null;
  const words = new Map<number, { v: bigint; b: bigint }>();
  const nonces = new Map<number, { v: bigint; b: bigint }>();
  let onHold: number[] = [];
  let serverOk = true;
  let slowedDown = false;
  let watched = { words: [] as number[], picks: [] as number[] };
  const subs = new Set<(s: SeatMapSnapshot) => void>();

  function absorb(read: SeatBatchRead): boolean {
    if (read.block === null) return false;
    const b = read.block;
    let changed = false;
    if (read.event && (!event || b >= event.b)) {
      const p = anchor(read.event);
      if (p) problem = p;
      changed ||= !event || JSON.stringify(event.v, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) !== JSON.stringify(read.event, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      event = { v: read.event, b };
    }
    for (const [w, v] of read.words) {
      const cur = words.get(w);
      if (!cur || b >= cur.b) { changed ||= cur?.v !== v; words.set(w, { v, b }); }
    }
    for (const [k, v] of read.nonces) {
      const cur = nonces.get(k);
      if (!cur || b >= cur.b) { changed ||= cur?.v !== v; nonces.set(k, { v, b }); }
    }
    return changed;
  }
  if (firstRead) absorb(firstRead);

  const snapshot = (): SeatMapSnapshot => ({
    chain: event && !problem
      ? {
        words: Array.from({ length: nWords }, (_, w) => words.get(w)?.v ?? null),
        remaining: event.v.remaining, cancelled: event.v.cancelled, eventEndTs: event.v.eventEndTs, blockTs: event.v.blockTs,
        nonces: new Map([...nonces].map(([k, x]) => [k, x.v])),
      }
      : null,
    onHold,
    serverOk,
    slowedDown,
  });
  const emit = () => { const s = snapshot(); for (const fn of subs) fn(s); };

  async function readHolds(): Promise<boolean> {
    try {
      const resp = await deps.fetch(`${deps.apiUrl.replace(/\/+$/, "")}/api/events/${encodeURIComponent(series.eventId)}/series/${encodeURIComponent(series.seriesId)}/held`);
      const body = (await resp.json()) as { ok?: boolean; data?: { seats?: unknown } };
      const seats = body?.data?.seats;
      if (!resp.ok || !body.ok) throw new Error("holds refused");
      const next = Array.isArray(seats) ? seats.filter((k): k is number => Number.isInteger(k) && k >= 0 && k < bp.seats) : [];
      const changed = !serverOk || next.length !== onHold.length || next.some((k, i) => k !== onHold[i]);
      onHold = next;
      serverOk = true;
      return changed;
    } catch {
      const changed = serverOk;
      serverOk = false;
      return changed;
    }
  }

  /** Batches for a full read: every word, each picked seat's nonce beside its word. */
  function fullBatches() {
    const out = [];
    for (let w0 = 0; w0 < nWords; w0 += SEAT_WORDS_PER_BATCH) {
      const ws = Array.from({ length: Math.min(SEAT_WORDS_PER_BATCH, nWords - w0) }, (_, i) => w0 + i);
      const nonceSeats = watched.picks.filter((k) => k >> 8 >= w0 && k >> 8 < w0 + ws.length);
      out.push(seatBatch(ledger, eventId, { event: w0 === 0, words: ws, nonceSeats }));
    }
    return out;
  }
  function viewBatch() {
    const ws = [...new Set([...watched.picks.map((k) => k >> 8), ...watched.words])].slice(0, SEAT_WORDS_PER_BATCH);
    return [seatBatch(ledger, eventId, { event: true, words: ws, nonceSeats: watched.picks })];
  }

  let inFlight: Promise<void> | null = null;
  async function refresh(full = false): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const [chain, holdsChanged] = await Promise.all([runBatches(deps, full ? fullBatches() : viewBatch()), readHolds()]);
      slowedDown = chain.rateLimited;
      let changed = holdsChanged;
      for (const r of chain.reads) changed = absorb(r) || changed;
      if (changed) emit();
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  // ── Scheduling ──────────────────────────────────────────────────────────────
  const setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const visible = deps.visible ?? (() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const random = deps.random ?? Math.random;
  let timer: unknown = null;
  let ticks = 0;
  let running = false;
  let backoff = REFRESH_MS;
  const onVisible = () => { if (visible() && running) void refresh(); };

  function schedule(): void {
    if (!running) return;
    const jitter = 0.8 + random() * 0.4;
    timer = setT(async () => {
      if (visible()) {
        ticks++;
        await refresh(ticks % FULL_EVERY === 0);
        backoff = slowedDown ? Math.min(MAX_BACKOFF_MS, backoff * 2) : REFRESH_MS;
      }
      schedule();
    }, backoff * jitter);
  }

  // The first full read: every word (the event check is already in hand, or arrives with it).
  await refresh(true);
  if (problem) return { ok: false, problem };

  const map: LiveSeatMap = {
    plan: bp,
    bandPrices,
    organiser,
    snapshot,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    watch({ onScreen, picks }) {
      watched = { words: [...new Set(onScreen.map((k) => k >> 8))], picks: [...picks] };
    },
    refresh,
    start() {
      if (running) return;
      running = true;
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
      schedule();
    },
    stop() {
      running = false;
      if (timer !== null) clearT(timer);
      timer = null;
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
    },
    get problem() { return problem; },
  };
  return { ok: true, map };
}
