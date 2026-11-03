import { test } from "node:test";
import assert from "node:assert/strict";
import { LAYOUT_TEMPLATES } from "@woco/shared/seating/templates";
import { encodeSeatPlan, freezeSeatPlan, seatPlanDigest } from "@woco/shared/seating/plan";
import { seatPlanEditionTemplate } from "@woco/shared/seating/template";
import { manifestV2Digest } from "@woco/shared/edition/canonical";
import { seatStates, SEAT_TAKEN, SEAT_FREE, SEAT_ON_HOLD, SEAT_UNCONFIRMED } from "@woco/shared/seating/availability";
import { loadSeatMap, type SeatMapDeps } from "../src/load.js";

const plan = freezeSeatPlan(LAYOUT_TEMPLATES.find((t) => t.id === "theatre")!.make());
const planBytes = encodeSeatPlan(plan);
const planDigest = seatPlanDigest(planBytes);
const PLAN_REF = "a".repeat(64), MANIFEST_REF = "b".repeat(64);
const body = {
  format: "woco.manifest.v2", totalSupply: plan.seats.length, issuer: `0x${"12".repeat(20)}`,
  metadataRoot: `0x${"34".repeat(32)}`, encoding: "cbor-v1", treeScheme: "oz-simple-v1",
  editionTemplate: seatPlanEditionTemplate({ ref: PLAN_REF, digest: planDigest, seats: plan.seats.length }),
};
const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
const MANIFEST_REF_ON_CHAIN = hex(manifestV2Digest(body as never));
const EVENT_ID = `0x${"7e".repeat(32)}`;
const LEDGER = `0x${"55".repeat(20)}`;
const series = {
  eventId: "evt-1", seriesId: "s1", onChainEventId: EVENT_ID, swarmManifestRef: MANIFEST_REF,
  seating: { bands: plan.bands.map((b, i) => ({ id: b.id, price: String(20 + i) })) },
};

const w = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");

/** A fake Arbitrum: decodes the real aggregate3 calldata and answers each call by selector. */
function chain(state: {
  block: bigint; taken: Set<number>; nonces?: Map<number, bigint>; seated?: boolean; manifestRef?: string;
  remaining?: bigint; missing?: boolean; status?: number; seen?: string[][];
}) {
  return (data: string): string | number => {
    if (state.status) return state.status;
    const b = Buffer.from(data.slice(10), "hex");
    const u = (at: number) => Number(b.readBigUInt64BE(at + 24));
    const n = u(u(0));
    const base = u(0) + 32;
    const answers: { ok: boolean; data: string }[] = [];
    const sels: string[] = [];
    for (let i = 0; i < n; i++) {
      const t = base + u(base + 32 * i);
      const dataAt = t + u(t + 64);
      const call = b.subarray(dataAt + 32, dataAt + 32 + u(dataAt)).toString("hex");
      const sel = call.slice(0, 8);
      sels.push(sel);
      const arg = (j: number) => BigInt(`0x${call.slice(8 + 64 * j, 8 + 64 * (j + 1))}`);
      const ok = (d: string) => answers.push({ ok: true, data: d });
      if (state.missing && sel !== "a3b1b31d" && sel !== "0f28c97d") { answers.push({ ok: false, data: "" }); continue; }
      switch (sel) {
        case "a3b1b31d": ok(w(state.block)); break;
        case "8c172fa2": ok(w(plan.seats.length) + w(state.taken.size) + w(0) + (state.manifestRef ?? MANIFEST_REF_ON_CHAIN).slice(2)); break;
        case "b2db691d": ok(w(state.seated === false ? 0 : 1)); break;
        case "4b0ecb30": ok(w(2_000_000_000) + w(0)); break;
        case "bc1ed74c": ok(w(state.remaining ?? BigInt(plan.seats.length - state.taken.size))); break;
        case "0f28c97d": ok(w(1_800_000_000)); break;
        case "10173035": {
          let word = 0n;
          for (const k of state.taken) if (k >> 8 === Number(arg(1))) word |= 1n << BigInt(k & 255);
          ok(w(word));
          break;
        }
        case "287af508": ok(w(state.nonces?.get(Number(arg(1))) ?? 0n)); break;
        default: answers.push({ ok: false, data: "" });
      }
    }
    state.seen?.push(sels);
    const tuples = answers.map((a) => {
      const len = a.data.length / 2;
      return w(a.ok ? 1 : 0) + w(0x40) + w(len) + a.data.padEnd(Math.ceil(len / 32) * 64, "0");
    });
    let off = 32 * tuples.length;
    const offs = tuples.map((t) => { const o = w(off); off += t.length / 2; return o; });
    return `0x${w(0x20)}${w(tuples.length)}${offs.join("")}${tuples.join("")}`;
  };
}

function deps(rpc: ReturnType<typeof chain>, opts: { manifest?: unknown; plan?: Uint8Array | number; holds?: unknown } = {}): SeatMapDeps {
  const fakeFetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === "https://rpc") {
      const r = rpc(JSON.parse(String(init!.body)).params[0].data);
      if (typeof r === "number") return new Response("", { status: r });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: r }));
    }
    if (url.endsWith(`/bytes/${MANIFEST_REF}`)) {
      return new Response(JSON.stringify(opts.manifest ?? { v: 2, signedManifest: { body, signature: "0x" }, objectRefs: [], manifestDigestHex: "0xdead" }));
    }
    if (url.endsWith(`/bytes/${PLAN_REF}`)) {
      if (typeof opts.plan === "number") return new Response("", { status: opts.plan, headers: opts.plan === 403 ? { "X-Chunk-Gate": "not-whitelisted" } : {} });
      return new Response((opts.plan ?? planBytes) as BodyInit);
    }
    if (url.includes("/held")) {
      if (opts.holds === "down") throw new Error("server down");
      return new Response(JSON.stringify({ ok: true, data: { held: 2, seats: opts.holds ?? [7, 8, -1, 1e9] } }));
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, gatewayUrl: "https://gw", rpcUrl: "https://rpc", apiUrl: "https://api", ledger: LEDGER, setTimeout: () => 0, clearTimeout: () => {} };
}

const none = { held: new Set<number>(), confirmed: new Map<number, number>() };
const statesOf = (snap: Awaited<ReturnType<typeof loadSeatMap>> & { ok: true }, mine: number[] = []) => {
  const s = snap.map.snapshot();
  return seatStates(snap.map.plan.plan, { chain: s.chain, organiser: none, onHold: s.onHold, mine, bandPrices: snap.map.bandPrices });
};

test("loads the plan the chain committed, with sold seats and holds", async () => {
  const r = await loadSeatMap(series, deps(chain({ block: 100n, taken: new Set([0, 300]) })));
  assert.ok(r.ok);
  assert.equal(r.map.plan.seats, plan.seats.length);
  assert.equal(r.map.plan.digest, planDigest);
  assert.deepEqual(r.map.bandPrices, plan.bands.map((_, i) => (20 + i) * 100));
  const s = statesOf(r);
  assert.equal(s.sale, "on-sale");
  assert.equal(s.codes[0], SEAT_TAKEN);
  assert.equal(s.codes[300], SEAT_TAKEN);
  assert.equal(s.codes[7], SEAT_ON_HOLD);
  assert.equal(s.codes[1], SEAT_FREE);
  assert.deepEqual(r.map.snapshot().onHold, [7, 8], "out-of-range holds dropped");
});

test("refuses to draw what the chain did not commit", async () => {
  assert.deepEqual(await loadSeatMap(series, deps(chain({ block: 1n, taken: new Set(), manifestRef: `0x${"99".repeat(32)}` }))), { ok: false, problem: "mismatch" });
  assert.deepEqual(await loadSeatMap(series, deps(chain({ block: 1n, taken: new Set(), seated: false }))), { ok: false, problem: "not-seated" });
  assert.deepEqual(await loadSeatMap(series, deps(chain({ block: 1n, taken: new Set(), missing: true }))), { ok: false, problem: "not-seated" });
  // A plan whose bytes are not the committed digest.
  const other = encodeSeatPlan(freezeSeatPlan(LAYOUT_TEMPLATES.find((t) => t.id === "comedy")!.make()));
  assert.deepEqual(await loadSeatMap(series, deps(chain({ block: 1n, taken: new Set() }), { plan: other })), { ok: false, problem: "mismatch" });
  // A manifest with no seat plan, or not a manifest.
  const { editionTemplate: _drop, ...plain } = body;
  assert.deepEqual(await loadSeatMap(series, deps(chain({ block: 1n, taken: new Set() }), { manifest: { signedManifest: { body: plain } } })), { ok: false, problem: "mismatch" });
  assert.deepEqual(await loadSeatMap(series, deps(chain({ block: 1n, taken: new Set() }), { manifest: { signedManifest: { body: { ...body, extra: 1 } } } })), { ok: false, problem: "mismatch" });
});

test("a plan our gateway does not serve yet reads as publishing", async () => {
  assert.deepEqual(await loadSeatMap(series, deps(chain({ block: 1n, taken: new Set() }), { plan: 404 })), { ok: false, problem: "publishing" });
  assert.deepEqual(await loadSeatMap(series, deps(chain({ block: 1n, taken: new Set() }), { plan: 403 })), { ok: false, problem: "publishing" });
  assert.deepEqual(await loadSeatMap(series, deps(chain({ block: 1n, taken: new Set() }), { plan: 502 })), { ok: false, problem: "unavailable" });
});

test("chain unreachable: the plan still draws, nothing is on sale; our server down: holds unknown, map still draws", async () => {
  const r = await loadSeatMap(series, deps(chain({ block: 1n, taken: new Set(), status: 503 })));
  assert.ok(r.ok);
  assert.equal(r.map.snapshot().chain, null);
  assert.equal(statesOf(r).sale, "unknown");
  const down = await loadSeatMap(series, deps(chain({ block: 1n, taken: new Set() }), { holds: "down" }));
  assert.ok(down.ok);
  assert.equal(down.map.snapshot().serverOk, false);
  assert.equal(statesOf(down).sale, "on-sale");
});

test("a read from an older block never undoes a newer one", async () => {
  const st = { block: 100n, taken: new Set([5]) };
  const r = await loadSeatMap(series, deps(chain(st)));
  assert.ok(r.ok);
  assert.equal(statesOf(r).codes[5], SEAT_TAKEN);
  // A lagging replica: older block, the seat looks free there.
  st.block = 90n;
  st.taken = new Set();
  await r.map.refresh(true);
  assert.equal(statesOf(r).codes[5], SEAT_TAKEN);
  // The chain moves on and a refund frees nothing (bits stay set), but a new sale shows.
  st.block = 101n;
  st.taken = new Set([5, 6]);
  await r.map.refresh(true);
  assert.equal(statesOf(r).codes[6], SEAT_TAKEN);
});

test("picked seats get their nonce read beside their word; an unconfirmed freed seat is not offered", async () => {
  const seen: string[][] = [];
  const st = { block: 10n, taken: new Set<number>(), nonces: new Map([[12, 1n]]), seen };
  const r = await loadSeatMap(series, deps(chain(st)));
  assert.ok(r.ok);
  r.map.watch({ onScreen: [0, 1, 2], picks: [12] });
  await r.map.refresh();
  const last = seen.at(-1)!;
  assert.ok(last.includes("287af508") && last.includes("10173035"), "nonce and word in one batch");
  assert.equal(statesOf(r).codes[12], SEAT_UNCONFIRMED);
});

test("the refresh loop backs off when the RPC says slow down, and reads nothing while hidden", async () => {
  const timers: { fn: () => void; ms: number }[] = [];
  let hidden = false;
  const st = { block: 1n, taken: new Set<number>(), status: 0 };
  const d = { ...deps(chain(st)), setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; }, visible: () => !hidden, random: () => 0.5 };
  const r = await loadSeatMap(series, d);
  assert.ok(r.ok);
  r.map.start();
  assert.equal(timers.at(-1)!.ms, 20_000);
  st.status = 429;
  await timers.at(-1)!.fn();
  assert.equal(r.map.snapshot().slowedDown, true);
  assert.equal(timers.at(-1)!.ms, 40_000, "backed off");
  st.status = 0;
  hidden = true;
  const seenBefore = timers.length;
  await timers.at(-1)!.fn();
  assert.equal(timers.length, seenBefore + 1, "rescheduled without reading");
  r.map.stop();
});
