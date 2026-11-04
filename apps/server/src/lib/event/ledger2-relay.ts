/**
 * The ledger2 relay: an organiser's ORGANISER KEY signs a change to its event and WoCo
 * submits it, paying the gas (step 1 of the ledger2 go-live; Fable design consult
 * 2026-11-02). The signature is the authority - the ledger checks it against the
 * event's organiser key at the current nonces - so nothing here can change an event
 * the organiser did not sign for. Everything below is what WoCo agrees to PAY for, and
 * the early, readable refusal of what the chain would refuse anyway:
 *
 *   - ids come from THIS server's registry, never the body (#424): the request names
 *     series, and only a series registered here on the configured ledger2 is acted on;
 *   - the signed-in account must be the event's organiser on chain (`getEvent`);
 *   - every signature is recovered locally against the nonces just read, so "your
 *     change went stale, sign again" is told apart from a wrong key, and the shared
 *     encoder is checked against the chain on every request;
 *   - the whole batch is simulated at `latest`, and refused on its first failure;
 *   - one relay per on-chain event at a time (the same signature posted twice would
 *     simulate clean twice and revert once, at our expense).
 *
 * "Registered an event" is the unlock: registration spent sponsor gas behind the Stripe
 * gate. Stripe is deliberately NOT re-checked: cancelling and cutting capacity protect
 * buyers, and an organiser Stripe has just disabled is exactly who must still be able to
 * cancel. The server stores nothing: a change lives in the request, then on chain.
 */

import {
  LEDGER2_MAX_SALES_EXTENSION_SECS,
  LEDGER2_NO_SEAT,
  isLedger2SeatKind,
  ledger2WindowRefusal,
  planSeatMoveNonces,
  recoverLedger2Signer,
  seatFromWire,
  type Ledger2Action,
  type Ledger2Kind,
  type Ledger2RelayResult,
  type Ledger2Target,
  type SeatSlotState,
} from "@woco/shared/ticket/ledger2-terms";
import type { EventContractTarget } from "../chain/event-contract.js";
import {
  ledger2RelayIface,
  landedLogs,
  RelayGasCeilingError,
  type CodeCheck,
  type LandedLog,
  type RelayCall,
  type SeriesChainState,
  type SimulatedCall,
  type SlotChainState,
} from "../chain/ledger2-relay-chain.js";

export const MAX_RELAY_ITEMS = 60;
export const MAX_RELAY_SEAT_MOVES = 50;
/** How long a request waits for the receipt before answering `unconfirmed`. */
export const RELAY_RECEIPT_WAIT_MS = 60_000;

export interface RelayTx {
  hash: string;
}

export interface RelayReceipt {
  status: number | null;
  logs: ReadonlyArray<{ address: string; topics: readonly string[]; data: string }>;
}

export interface Ledger2RelayDeps {
  activeChainId(): number;
  ledger2Address(chainId: number): string | null;
  registration(eventId: string, seriesId: string): { onChainEventId: string; contract: EventContractTarget } | null;
  relayConfigured(): boolean;
  verifyCode(chainId: number, ledger: string): Promise<CodeCheck>;
  chainNow(chainId: number): Promise<number>;
  seriesState(chainId: number, ledger: string, onChainEventId: string): Promise<SeriesChainState>;
  slotState(chainId: number, ledger: string, onChainEventId: string, slot: number): Promise<SlotChainState>;
  seatNonce(chainId: number, ledger: string, onChainEventId: string, seat: bigint): Promise<bigint>;
  holds(eventId: string, seriesId: string): { held: number; expiresBy: number | null };
  cancellationGate(eventId: string): "open" | "cancelled" | "unknown";
  simulate(chainId: number, ledger: string, calls: readonly RelayCall[]): Promise<SimulatedCall[]>;
  send(chainId: number, ledger: string, calls: readonly RelayCall[], label: string): Promise<RelayTx>;
  waitReceipt(tx: RelayTx, timeoutMs: number): Promise<RelayReceipt | null>;
  /** Our relay moved a cutoff: drop whatever remembers the old one. */
  onExtended(contract: EventContractTarget, onChainEventId: string): void;
  log(msg: string): void;
}

export type RelayRefusal = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 413 | 502 | 503;
  error: string;
  detail?: Record<string, unknown>;
};

const refuse = (status: RelayRefusal["status"], error: string, detail?: Record<string, unknown>): RelayRefusal => ({
  ok: false,
  status,
  error,
  ...(detail ? { detail } : {}),
});

// ── Request shape ────────────────────────────────────────────────────────────

/** A plain EOA signature: the ledger is EOA-only by design (`ECDSA.recoverCalldata`). */
const SIG_RE = /^0x[0-9a-fA-F]{130}$/;
const SERIES_RE = /^[\w-]{1,100}$/;

interface ParsedItem {
  index: number;
  kind: Ledger2Kind;
  seriesId: string;
  issuedAt: number;
  deadline: number;
  sig: string;
  supply?: number;
  eventEndTs?: number;
  slot?: number;
  toSeat?: bigint;
  holderSig?: string;
}

interface ParsedAbort {
  seriesId: string;
  issuedAt: number;
  deadline: number;
  sig: string;
}

const isSafeUint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function parseRequest(
  raw: unknown,
  allowed: ReadonlySet<Ledger2Kind>,
): { items: ParsedItem[]; aborts: ParsedAbort[] } | RelayRefusal {
  if (typeof raw !== "object" || raw === null) return refuse(400, "invalid_request");
  const { items, aborts } = raw as { items?: unknown; aborts?: unknown };
  if (!Array.isArray(items) || items.length === 0) return refuse(400, "invalid_request", { why: "items" });
  if (items.length > MAX_RELAY_ITEMS) return refuse(413, "batch_too_large", { max: MAX_RELAY_ITEMS });

  const parsed: ParsedItem[] = [];
  for (let index = 0; index < items.length; index++) {
    const it = items[index] as Record<string, unknown> | null;
    if (typeof it !== "object" || it === null) return refuse(400, "invalid_item", { index });
    const kind = it.kind as Ledger2Kind;
    if (!allowed.has(kind)) return refuse(400, "kind_not_accepted", { index });
    if (typeof it.seriesId !== "string" || !SERIES_RE.test(it.seriesId)) return refuse(400, "invalid_item", { index, field: "seriesId" });
    if (!isSafeUint(it.issuedAt) || !isSafeUint(it.deadline)) return refuse(400, "window_invalid", { index });
    if (typeof it.sig !== "string" || !SIG_RE.test(it.sig)) return refuse(400, "invalid_item", { index, field: "sig" });
    const p: ParsedItem = { index, kind, seriesId: it.seriesId, issuedAt: it.issuedAt, deadline: it.deadline, sig: it.sig };
    if (kind === "setSupply") {
      if (!isSafeUint(it.supply) || it.supply < 1) return refuse(400, "invalid_item", { index, field: "supply" });
      p.supply = it.supply;
    } else if (kind === "extendSalesEnd") {
      if (!isSafeUint(it.eventEndTs)) return refuse(400, "invalid_item", { index, field: "eventEndTs" });
      p.eventEndTs = it.eventEndTs;
    } else if (isLedger2SeatKind(kind)) {
      if (!isSafeUint(it.slot)) return refuse(400, "invalid_item", { index, field: "slot" });
      if (it.toSeat !== "none" && !isSafeUint(it.toSeat)) return refuse(400, "invalid_item", { index, field: "toSeat" });
      p.slot = it.slot;
      p.toSeat = seatFromWire(it.toSeat as number | "none");
      if (kind === "reseat") {
        if (typeof it.holderSig !== "string" || !SIG_RE.test(it.holderSig)) {
          return refuse(400, "invalid_item", { index, field: "holderSig" });
        }
        p.holderSig = it.holderSig;
      } else if (it.holderSig !== undefined) {
        return refuse(400, "invalid_item", { index, field: "holderSig" });
      }
    }
    parsed.push(p);
  }

  const seatMoves = parsed.filter((p) => isLedger2SeatKind(p.kind)).length;
  if (seatMoves > MAX_RELAY_SEAT_MOVES) return refuse(413, "batch_too_large", { maxSeatMoves: MAX_RELAY_SEAT_MOVES });

  // A revoke is the "Cancel" of a change still saving: a request of its own. Beside a
  // change it would either kill that change or land after it and do nothing.
  const revokes = parsed.filter((p) => p.kind === "revoke").length;
  if (revokes > 0 && revokes !== parsed.length) return refuse(400, "revoke_alone");

  // One terms write per series: the second would meet the nonce the first just moved.
  const termsSeries = new Set<string>();
  for (const p of parsed) {
    if (isLedger2SeatKind(p.kind)) continue;
    if (termsSeries.has(p.seriesId)) return refuse(400, "duplicate_series", { index: p.index });
    termsSeries.add(p.seriesId);
  }

  const parsedAborts: ParsedAbort[] = [];
  if (aborts !== undefined) {
    if (!Array.isArray(aborts) || aborts.length > MAX_RELAY_ITEMS) return refuse(400, "invalid_request", { why: "aborts" });
    const seen = new Set<string>();
    const named = new Set(parsed.map((p) => p.seriesId));
    for (const a of aborts as Array<Record<string, unknown> | null>) {
      if (typeof a !== "object" || a === null) return refuse(400, "invalid_abort");
      if (typeof a.seriesId !== "string" || !named.has(a.seriesId) || seen.has(a.seriesId)) return refuse(400, "invalid_abort");
      if (!isSafeUint(a.issuedAt) || !isSafeUint(a.deadline)) return refuse(400, "window_invalid", { abort: a.seriesId });
      if (typeof a.sig !== "string" || !SIG_RE.test(a.sig)) return refuse(400, "invalid_abort");
      seen.add(a.seriesId);
      parsedAborts.push({ seriesId: a.seriesId, issuedAt: a.issuedAt, deadline: a.deadline, sig: a.sig });
    }
  }
  return { items: parsed, aborts: parsedAborts };
}

// ── In flight ────────────────────────────────────────────────────────────────

const inFlight = new Set<string>();

/** Tests only. */
export function _resetLedger2RelayLocksForTests(): void {
  inFlight.clear();
}

// ── Prepare ──────────────────────────────────────────────────────────────────

/** A change checked against the chain and simulated, holding its events' locks. */
export interface PreparedRelay {
  chainId: number;
  ledger: string;
  contract: EventContractTarget;
  calls: RelayCall[];
  /** Per call: the request item it is and the log that proves it landed. */
  expect: Array<{ index: number; log: LandedLog["name"]; onChainEventId: string; slot?: number }>;
  /** Per request item, its on-chain id (for the caller). */
  itemCount: number;
  aborts: RelayCall[];
  label: string;
  release(): void;
}

const LOG_FOR: Record<Ledger2Kind, LandedLog["name"]> = {
  setSupply: "SupplySet",
  extendSalesEnd: "SalesEndExtended",
  cancel: "EventCancelled",
  revoke: "SignaturesRevoked",
  reseat: "SlotReseated",
  reseatBearer: "SlotReseated",
};

/** The ledger error a simulation met, as the code the client reads. */
const SIMULATION_REFUSAL: Record<string, [RelayRefusal["status"], string]> = {
  NotOrganiserKey: [409, "signature_stale"],
  SignatureExpired: [400, "signature_expiring"],
  SignatureNotYetValid: [400, "signature_not_yet_valid"],
  DeadlineTooFar: [400, "deadline_too_far"],
  AlreadyCancelled: [409, "event_cancelled"],
  SalesClosed: [409, "sales_closed"],
  SupplyUnchanged: [409, "supply_unchanged"],
  InsufficientSupply: [409, "supply_below_sold"],
  SupplyAboveRegistered: [400, "supply_above_registered"],
  InvalidEventEnd: [409, "sales_end_not_later"],
  SalesEndTooFar: [400, "sales_end_too_far"],
  NotSeated: [409, "not_seated"],
  InvalidSeat: [400, "invalid_seat"],
  SeatTaken: [409, "seat_taken"],
  SeatUnchanged: [409, "seat_unchanged"],
  SlotUnclaimed: [400, "slot_unclaimed"],
  NotBearer: [409, "seat_move_needs_holder"],
  SlotHeld: [409, "seat_move_needs_holder"],
  BearerMintsOff: [409, "seat_moves_off"],
  NotSlotOwner: [409, "holder_signature_invalid"],
};

export interface PrepareInput {
  /** The WoCo event id: the route param ownership was resolved against (#389). */
  eventId: string;
  /** The VERIFIED session parent, lowercase. */
  parent: string;
  /** The series the event's own feed declares. */
  seriesIds: readonly string[];
  request: unknown;
  allowed: ReadonlySet<Ledger2Kind>;
  label: string;
}

export async function prepareLedger2Relay(
  input: PrepareInput,
  deps: Ledger2RelayDeps,
): Promise<{ ok: true; prepared: PreparedRelay } | RelayRefusal> {
  const parsed = parseRequest(input.request, input.allowed);
  if ("ok" in parsed) return parsed;
  const { items, aborts } = parsed;

  // Resolve every series to the registration THIS server made, on the ledger2 it is
  // configured for, on the active chain. Anything else is not ours to pay for.
  const chainId = deps.activeChainId();
  const ledger = deps.ledger2Address(chainId);
  if (!ledger) return refuse(404, "not_available");
  const declared = new Set(input.seriesIds);
  const ids = new Map<string, string>();
  let contract: EventContractTarget | null = null;
  for (const seriesId of new Set(items.map((i) => i.seriesId))) {
    if (!declared.has(seriesId)) return refuse(404, "series_not_found", { seriesId });
    const reg = deps.registration(input.eventId, seriesId);
    if (
      !reg ||
      reg.contract.version !== "ledger2" ||
      reg.contract.chainId !== chainId ||
      reg.contract.address.toLowerCase() !== ledger
    ) {
      return refuse(404, "not_available", { seriesId });
    }
    ids.set(seriesId, reg.onChainEventId.toLowerCase());
    contract = reg.contract;
  }
  if (!contract) return refuse(400, "invalid_request");
  if (!deps.relayConfigured()) return refuse(503, "relay_unavailable");

  // The server's own cancellation record outranks everything but a cancel or a revoke.
  const gate = deps.cancellationGate(input.eventId);
  if (gate !== "open" && items.some((i) => i.kind !== "cancel" && i.kind !== "revoke")) {
    return refuse(409, gate === "cancelled" ? "event_cancelled" : "cancellation_unknown");
  }

  const lockKeys = [...new Set(ids.values())].map((id) => `${chainId}:${ledger}:${id}`);
  if (lockKeys.some((k) => inFlight.has(k))) return refuse(409, "in_flight");
  for (const k of lockKeys) inFlight.add(k);
  const release = () => {
    for (const k of lockKeys) inFlight.delete(k);
  };

  try {
    const outcome = await checkAndSimulate(input, deps, { items, aborts, chainId, ledger, contract, ids });
    if (!outcome.ok) {
      release();
      return outcome;
    }
    return { ok: true, prepared: { ...outcome.prepared, release } };
  } catch (err) {
    release();
    throw err;
  }
}

async function checkAndSimulate(
  input: PrepareInput,
  deps: Ledger2RelayDeps,
  ctx: {
    items: ParsedItem[];
    aborts: ParsedAbort[];
    chainId: number;
    ledger: string;
    contract: EventContractTarget;
    ids: Map<string, string>;
  },
): Promise<{ ok: true; prepared: Omit<PreparedRelay, "release"> } | RelayRefusal> {
  const { items, aborts, chainId, ledger, contract, ids } = ctx;
  const target: Ledger2Target = { chainId, address: ledger };

  let code: CodeCheck;
  let chainNow: number;
  const states = new Map<string, SeriesChainState>();
  try {
    code = await deps.verifyCode(chainId, ledger);
    chainNow = await deps.chainNow(chainId);
    await Promise.all(
      [...ids].map(async ([seriesId, id]) => states.set(seriesId, await deps.seriesState(chainId, ledger, id))),
    );
  } catch {
    return refuse(502, "chain_unverified");
  }
  if (!code.ok) {
    deps.log(`[ledger2-relay] refusing every relay: ${code.reason}`);
    return refuse(503, "relay_unavailable");
  }

  for (const it of [...items, ...aborts.map((a) => ({ ...a, index: -1 }))]) {
    const why = ledger2WindowRefusal(it.issuedAt, it.deadline, chainNow);
    if (why) return refuse(400, why, it.index >= 0 ? { index: it.index } : { abort: it.seriesId });
  }

  for (const [seriesId, s] of states) {
    if (s.organiser !== input.parent) return refuse(403, "not_organiser", { seriesId });
  }

  // Seat state for every slot a move names and every seat one moves into.
  const seatItems = items.filter((i) => isLedger2SeatKind(i.kind));
  const slots = new Map<string, Map<number, SeatSlotState>>();
  const seats = new Map<string, Map<bigint, bigint>>();
  if (seatItems.length > 0) {
    // Each distinct slot and target seat read once (two moves on one slot are common).
    const reads: Array<Promise<void>> = [];
    for (const i of seatItems) {
      const id = ids.get(i.seriesId)!;
      const sl = slots.get(i.seriesId) ?? new Map<number, SeatSlotState>();
      slots.set(i.seriesId, sl);
      const se = seats.get(i.seriesId) ?? new Map<bigint, bigint>();
      seats.set(i.seriesId, se);
      if (!sl.has(i.slot!)) {
        sl.set(i.slot!, { owner: "", transferNonce: 0n, seat: LEDGER2_NO_SEAT });
        reads.push(deps.slotState(chainId, ledger, id, i.slot!).then((s) => void sl.set(i.slot!, s)));
      }
      if (i.toSeat !== LEDGER2_NO_SEAT && !se.has(i.toSeat!)) {
        se.set(i.toSeat!, 0n);
        reads.push(deps.seatNonce(chainId, ledger, id, i.toSeat!).then((n) => void se.set(i.toSeat!, n)));
      }
    }
    try {
      await Promise.all(reads);
    } catch {
      return refuse(502, "chain_unverified");
    }
  }

  // Each series' seat moves, in request order, with the nonces earlier moves leave.
  const seatPlan = new Map<number, { holder: string; nonce: bigint; termsNonce: bigint; seatNonce: bigint }>();
  for (const [seriesId, sl] of slots) {
    const moves = seatItems.filter((i) => i.seriesId === seriesId);
    const plan = planSeatMoveNonces(states.get(seriesId)!.termsNonce, sl, seats.get(seriesId)!, moves.map((m) => ({ slot: m.slot!, toSeat: m.toSeat! })));
    if (!plan) return refuse(409, "seat_move_invalid", { seriesId });
    moves.forEach((m, k) => seatPlan.set(m.index, plan[k]!));
  }

  const held = new Map<string, { held: number; expiresBy: number | null }>();
  for (const it of items) {
    const s = states.get(it.seriesId)!;
    const id = ids.get(it.seriesId)!;
    const closed = chainNow >= s.eventEndTs;
    const at = { index: it.index, seriesId: it.seriesId };

    let action: Ledger2Action;
    switch (it.kind) {
      case "setSupply": {
        // A seated series' supply is its plan's seats: capacity is hold / release, and
        // a cut below the seats would strand seats the map shows free (SEATING.md "Relay").
        if (s.seated) return refuse(409, "seated_supply", at);
        if (s.cancelled) return refuse(409, "event_cancelled", at);
        if (closed) return refuse(409, "sales_closed", at);
        if (it.supply! > s.registeredSupply) return refuse(400, "supply_above_registered", { ...at, max: s.registeredSupply });
        if (it.supply === s.totalSupply) return refuse(409, "supply_unchanged", at);
        const h = held.get(it.seriesId) ?? deps.holds(input.eventId, it.seriesId);
        held.set(it.seriesId, h);
        const minSupply = Math.max(1, s.nextSlot + h.held);
        if (it.supply! < minSupply) {
          // Holds last at most 10 minutes; refusing costs the organiser a short wait,
          // allowing would charge then refund every buyer still paying.
          return refuse(409, "supply_below_sold_or_held", {
            ...at,
            minSupply,
            sold: s.nextSlot,
            held: h.held,
            ...(h.held > 0 && h.expiresBy !== null ? { holdsExpireBy: new Date(h.expiresBy).toISOString() } : {}),
          });
        }
        action = { kind: "setSupply", eventId: id, supply: it.supply!, nonce: s.termsNonce, issuedAt: it.issuedAt, deadline: it.deadline };
        break;
      }
      case "extendSalesEnd": {
        if (s.cancelled) return refuse(409, "event_cancelled", at);
        if (closed) return refuse(409, "sales_closed", at);
        if (it.eventEndTs! <= s.eventEndTs) return refuse(409, "sales_end_not_later", { ...at, current: s.eventEndTs });
        if (it.eventEndTs! > chainNow + LEDGER2_MAX_SALES_EXTENSION_SECS) return refuse(400, "sales_end_too_far", at);
        action = { kind: "extendSalesEnd", eventId: id, eventEndTs: it.eventEndTs!, nonce: s.termsNonce, issuedAt: it.issuedAt, deadline: it.deadline };
        break;
      }
      case "cancel":
        if (s.cancelled) return refuse(409, "already_cancelled", at);
        action = { kind: "cancel", eventId: id, nonce: s.termsNonce, issuedAt: it.issuedAt, deadline: it.deadline };
        break;
      case "revoke":
        action = { kind: "revoke", eventId: id, nonce: s.termsNonce, issuedAt: it.issuedAt, deadline: it.deadline };
        break;
      case "reseat":
      case "reseatBearer": {
        if (!s.seated) return refuse(409, "not_seated", at);
        if (s.cancelled) return refuse(409, "event_cancelled", at);
        if (closed) return refuse(409, "sales_closed", at);
        if (it.slot! >= s.nextSlot) return refuse(400, "slot_unclaimed", at);
        if (it.toSeat !== LEDGER2_NO_SEAT && it.toSeat! >= BigInt(s.registeredSupply)) return refuse(400, "invalid_seat", at);
        const n = seatPlan.get(it.index)!;
        action = {
          kind: it.kind, eventId: id, slot: it.slot!, toSeat: it.toSeat!,
          holder: n.holder, nonce: n.nonce, termsNonce: n.termsNonce, seatNonce: n.seatNonce,
          issuedAt: it.issuedAt, deadline: it.deadline,
        };
        if (it.kind === "reseat" && recoverLedger2Signer(target, action, it.holderSig) !== n.holder) {
          return refuse(409, "holder_signature_invalid", at);
        }
        break;
      }
    }
    if (recoverLedger2Signer(target, action, it.sig) !== s.organiserKey) {
      // The nonce moved since the organiser signed, or the key did. On a revoke that
      // usually means the change it was cancelling has landed: the client reads the
      // chain to say which (`ledger2-change` outcome read).
      return refuse(409, it.kind === "revoke" ? "nonce_moved" : "signature_stale", {
        ...at,
        termsNonce: s.termsNonce.toString(),
      });
    }
  }

  const abortCalls: RelayCall[] = [];
  for (const a of aborts) {
    const s = states.get(a.seriesId)!;
    const id = ids.get(a.seriesId)!;
    const action: Ledger2Action = { kind: "revoke", eventId: id, nonce: s.termsNonce, issuedAt: a.issuedAt, deadline: a.deadline };
    if (recoverLedger2Signer(target, action, a.sig) !== s.organiserKey) {
      return refuse(409, "signature_stale", { abort: a.seriesId, termsNonce: s.termsNonce.toString() });
    }
    abortCalls.push({ data: encode(action, a.sig), allowFailure: true });
  }

  // Seat moves first and all-or-nothing; terms writes after, each on its own.
  const ordered = [...items.filter((i) => isLedger2SeatKind(i.kind)), ...items.filter((i) => !isLedger2SeatKind(i.kind))];
  const calls: RelayCall[] = [];
  const expect: PreparedRelay["expect"] = [];
  for (const it of ordered) {
    const id = ids.get(it.seriesId)!;
    calls.push({ data: encodeItem(it, id), allowFailure: !isLedger2SeatKind(it.kind) });
    expect.push({ index: it.index, log: LOG_FOR[it.kind], onChainEventId: id, ...(it.slot !== undefined ? { slot: it.slot } : {}) });
  }

  let sim: SimulatedCall[];
  try {
    sim = await deps.simulate(chainId, ledger, calls);
  } catch {
    return refuse(502, "chain_unverified");
  }
  const first = sim.findIndex((r) => !r.success);
  if (first >= 0) {
    const it = ordered[first]!;
    const [status, named] = SIMULATION_REFUSAL[sim[first]!.error ?? ""] ?? [409, "relay_refused"];
    const error = named === "signature_stale" && it.kind === "revoke" ? "nonce_moved" : named;
    return refuse(status, error, { index: it.index, seriesId: it.seriesId });
  }

  return {
    ok: true,
    prepared: { chainId, ledger, contract, calls, expect, itemCount: items.length, aborts: abortCalls, label: input.label },
  };
}

function encode(action: Ledger2Action, sig: string, holderSig?: string): string {
  switch (action.kind) {
    case "setSupply":
      return ledger2RelayIface.encodeFunctionData("setSupplyWithSignature", [action.eventId, action.supply, action.issuedAt, action.deadline, sig]);
    case "extendSalesEnd":
      return ledger2RelayIface.encodeFunctionData("extendSalesEndWithSignature", [action.eventId, action.eventEndTs, action.issuedAt, action.deadline, sig]);
    case "cancel":
      return ledger2RelayIface.encodeFunctionData("cancelEventWithSignature", [action.eventId, action.issuedAt, action.deadline, sig]);
    case "revoke":
      return ledger2RelayIface.encodeFunctionData("revokeSignaturesWithSignature", [action.eventId, action.issuedAt, action.deadline, sig]);
    case "reseatBearer":
      return ledger2RelayIface.encodeFunctionData("reseatBearer", [action.eventId, action.slot, action.toSeat, action.issuedAt, action.deadline, sig]);
    case "reseat":
      return ledger2RelayIface.encodeFunctionData("reseat", [action.eventId, action.slot, action.toSeat, action.issuedAt, action.deadline, sig, holderSig]);
  }
}

/** Calldata from the request's typed fields: never calldata the caller wrote. */
function encodeItem(it: ParsedItem, eventId: string): string {
  const w = { issuedAt: it.issuedAt, deadline: it.deadline };
  switch (it.kind) {
    case "setSupply":
      return encode({ kind: "setSupply", eventId, supply: it.supply!, nonce: 0n, ...w }, it.sig);
    case "extendSalesEnd":
      return encode({ kind: "extendSalesEnd", eventId, eventEndTs: it.eventEndTs!, nonce: 0n, ...w }, it.sig);
    case "cancel":
    case "revoke":
      return encode({ kind: it.kind, eventId, nonce: 0n, ...w }, it.sig);
    case "reseat":
    case "reseatBearer":
      return encode(
        { kind: it.kind, eventId, slot: it.slot!, toSeat: it.toSeat!, holder: "", nonce: 0n, termsNonce: 0n, seatNonce: 0n, ...w },
        it.sig,
        it.holderSig,
      );
  }
}

// ── Submit ───────────────────────────────────────────────────────────────────

export async function submitLedger2Relay(
  prepared: PreparedRelay,
  deps: Ledger2RelayDeps,
): Promise<{ ok: true; result: Ledger2RelayResult } | RelayRefusal> {
  try {
    let tx: RelayTx;
    try {
      tx = await deps.send(prepared.chainId, prepared.ledger, prepared.calls, prepared.label);
    } catch (err) {
      if (err instanceof RelayGasCeilingError) return refuse(413, "batch_too_large");
      logFailure(deps, `${prepared.label} send`, err);
      // A send that threw may still have been broadcast: the client decides from chain.
      return refuse(502, "relay_failed");
    }

    let receipt: RelayReceipt | null;
    try {
      receipt = await deps.waitReceipt(tx, RELAY_RECEIPT_WAIT_MS);
    } catch (err) {
      logFailure(deps, `${prepared.label} receipt`, err);
      receipt = null;
    }
    if (!receipt) return { ok: true, result: { status: "unconfirmed", txHash: tx.hash } };

    if (receipt.status !== 1) {
      deps.log(`[ledger2-relay] ${prepared.label} reverted on chain txHash=${tx.hash}`);
      const aborted = prepared.aborts.length > 0 ? await submitAborts(prepared, deps) : false;
      return { ok: true, result: { status: "reverted_on_chain", txHash: tx.hash, aborted } };
    }

    const logs = landedLogs(prepared.ledger, receipt.logs);
    const used = new Set<number>();
    const landed = new Array<boolean>(prepared.itemCount).fill(false);
    for (const e of prepared.expect) {
      const k = logs.findIndex(
        (l, i) => !used.has(i) && l.name === e.log && l.eventId === e.onChainEventId && (e.slot === undefined || l.slot === e.slot),
      );
      if (k >= 0) {
        used.add(k);
        landed[e.index] = true;
        if (e.log === "SalesEndExtended") deps.onExtended(prepared.contract, e.onChainEventId);
      }
    }
    deps.log(`[ledger2-relay] ${prepared.label} landed ${landed.filter(Boolean).length}/${landed.length} txHash=${tx.hash}`);
    return { ok: true, result: { status: "landed", txHash: tx.hash, landed } };
  } finally {
    prepared.release();
  }
}

/**
 * The batch reverted on chain, so its signatures are public. Revoke at the same nonce,
 * which kills every one still valid - in particular the moves of a dependent seat
 * rearrangement that did not hit the failure. Best effort: the client re-reads the
 * nonce and revokes itself if this did not land.
 */
async function submitAborts(prepared: PreparedRelay, deps: Ledger2RelayDeps): Promise<boolean> {
  try {
    const sim = await deps.simulate(prepared.chainId, prepared.ledger, prepared.aborts);
    const live = prepared.aborts.filter((_, i) => sim[i]?.success);
    if (live.length === 0) return false;
    const tx = await deps.send(prepared.chainId, prepared.ledger, live, `${prepared.label}.abort`);
    const receipt = await deps.waitReceipt(tx, RELAY_RECEIPT_WAIT_MS);
    return receipt?.status === 1;
  } catch (err) {
    logFailure(deps, `${prepared.label} abort`, err);
    return false;
  }
}

/**
 * WITHOUT `err.message`: ethers appends the transaction to it, calldata and so every
 * signature included (`routes/sub-ens.ts` `logRelayFailure`).
 */
function logFailure(deps: Ledger2RelayDeps, what: string, err: unknown): void {
  const diag = (err as { shortMessage?: string; code?: string }) ?? {};
  deps.log(`[ledger2-relay] ${what} failed code=${diag.code ?? "none"}: ${diag.shortMessage ?? "unspecified error"}`);
}
