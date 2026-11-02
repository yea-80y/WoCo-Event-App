/**
 * An organiser changing its ledger2 event: capacity, the sales cutoff, cancelling.
 * The ORGANISER KEY signs (`@woco/shared/crypto/organiser-key`, derived only after the
 * organiser unlock, zeroed at once); WoCo's relay submits it (`POST
 * /api/events/:id/ledger2/relay`, cancels through `/:id/cancel`).
 *
 * Client-first: everything signed over is read here, from the chain, never from a
 * server reply - each series' nonce, cutoff, supply and key, and the chain's own clock
 * for the signature window. Before signing, each digest is compared with the ledger's
 * own `*Digest` view, and a mismatch refuses to sign (the sub-ENS pointer's rule).
 *
 * "Cancel" on a change still saving is a revoke at the SAME nonce: whichever lands
 * first wins, and the chain is read afterwards to say which. The words "revoke" and
 * anything about the chain stay out of what organisers see.
 *
 * Inert until ledger2 is deployed: no deployment, no series to change.
 */

import type { EventFeed } from "@woco/shared";
import type {
  Ledger2Action,
  Ledger2RelayItem,
  Ledger2RelayRequest,
  Ledger2RelayResult,
  Ledger2Target,
} from "@woco/shared/ticket/ledger2-terms";

/** One ticket type of the event, as its ledger2 registration reads now. */
export interface Ledger2SeriesView {
  seriesId: string;
  name: string;
  onChainEventId: string;
  totalSupply: number;
  /** Tickets sold so far. */
  nextSlot: number;
  registeredSupply: number;
  /** Epoch seconds. */
  eventEndTs: number;
  cancelled: boolean;
  termsNonce: bigint;
  organiserKey: string;
}

export interface Ledger2EventView {
  target: Ledger2Target;
  /** Chain time at the read, epoch seconds. */
  chainNow: number;
  series: Ledger2SeriesView[];
}

export interface SeriesRead {
  organiser: string;
  organiserKey: string;
  totalSupply: number;
  nextSlot: number;
  registeredSupply: number;
  eventEndTs: number;
  cancelled: boolean;
  termsNonce: bigint;
}

/** What this module needs from the outside: the live wiring is `organiser-changes-live.ts`. */
export interface Ledger2ClientIO {
  deployment(): Promise<Ledger2Target | null>;
  /** Per id, its state, or null when this ledger does not know it. Throws when unread. */
  readSeries(ledger: string, ids: readonly string[]): Promise<Array<SeriesRead | null>>;
  chainNow(): Promise<number>;
  /** The ledger's own digest for `action` (its `*Digest` view). */
  chainDigest(ledger: string, action: Ledger2Action): Promise<string>;
  /** The organiser key, after the organiser unlock. The caller zeroes it. */
  organiserKey(): Promise<{ privateKey: Uint8Array; address: string }>;
  /** POST the relay; throws an `ApiError` carrying the server's code. */
  relay(eventId: string, request: Ledger2RelayRequest): Promise<Ledger2RelayResult>;
  sleep(ms: number): Promise<void>;
}

export class Ledger2ChangeError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "Ledger2ChangeError";
  }
}

/**
 * The event's ticket types registered on ledger2 with this account as organiser. Null
 * when there is no ledger2 (not deployed) or none of its series is on it. Throws when
 * the chain could not be read.
 */
export async function readLedger2Event(event: EventFeed, parent: string, io: Ledger2ClientIO): Promise<Ledger2EventView | null> {
  const target = await io.deployment();
  if (!target) return null;
  const candidates = event.series.filter((s) => typeof s.onChainEventId === "string" && /^0x[0-9a-fA-F]{64}$/.test(s.onChainEventId));
  if (candidates.length === 0) return null;
  const [reads, chainNow] = await Promise.all([
    io.readSeries(target.address, candidates.map((s) => s.onChainEventId!.toLowerCase())),
    io.chainNow(),
  ]);
  const me = parent.toLowerCase();
  const series: Ledger2SeriesView[] = [];
  candidates.forEach((s, i) => {
    const r = reads[i];
    if (!r || r.organiser.toLowerCase() !== me) return;
    series.push({ seriesId: s.seriesId, name: s.name, onChainEventId: s.onChainEventId!.toLowerCase(), ...r, organiserKey: r.organiserKey.toLowerCase() });
  });
  return series.length > 0 ? { target, chainNow, series } : null;
}

export type TermsChange =
  | { kind: "setSupply"; seriesId: string; supply: number }
  | { kind: "extendSalesEnd"; seriesId: string; eventEndTs: number }
  | { kind: "cancel"; seriesId: string }
  | { kind: "revoke"; seriesId: string };

/**
 * Sign `changes` against `view` (fresh: the nonces it holds are what the signatures
 * commit to). One chain-clock read for the window; each digest checked against the
 * ledger's before the key signs anything.
 */
export async function signTermsChanges(
  view: Ledger2EventView,
  changes: readonly TermsChange[],
  io: Ledger2ClientIO,
): Promise<Ledger2RelayItem[]> {
  const { ledger2SignatureWindow, ledger2Digest, signLedger2Action } = await import("@woco/shared/ticket/ledger2-terms");
  const window = ledger2SignatureWindow(await io.chainNow());
  const actions = changes.map((c) => {
    const s = view.series.find((x) => x.seriesId === c.seriesId);
    if (!s) throw new Ledger2ChangeError("That ticket type can't be changed here.", "series_not_found");
    const base = { eventId: s.onChainEventId, nonce: s.termsNonce, ...window };
    const action: Ledger2Action =
      c.kind === "setSupply"
        ? { kind: "setSupply", supply: c.supply, ...base }
        : c.kind === "extendSalesEnd"
          ? { kind: "extendSalesEnd", eventEndTs: c.eventEndTs, ...base }
          : { kind: c.kind, ...base };
    return { change: c, series: s, action };
  });

  const onChain = await Promise.all(actions.map((a) => io.chainDigest(view.target.address, a.action)));
  actions.forEach((a, i) => {
    if (ledger2Digest(view.target, a.action).toLowerCase() !== onChain[i]!.toLowerCase()) {
      throw new Ledger2ChangeError(
        "Refusing to sign: this app and your event's ticket record disagree on what a change looks like. Nothing was signed. Please report this.",
        "digest_mismatch",
      );
    }
  });

  const key = await io.organiserKey();
  try {
    for (const a of actions) {
      if (key.address.toLowerCase() !== a.series.organiserKey) {
        throw new Ledger2ChangeError(
          "This device's key for your events isn't the current one. Sign in again, then retry.",
          "key_moved",
        );
      }
    }
    return actions.map(({ change, action }) => {
      const sig = signLedger2Action(view.target, action, key.privateKey);
      const w = { issuedAt: action.issuedAt, deadline: action.deadline, sig };
      return change.kind === "setSupply"
        ? { kind: "setSupply", seriesId: change.seriesId, supply: change.supply, ...w }
        : change.kind === "extendSalesEnd"
          ? { kind: "extendSalesEnd", seriesId: change.seriesId, eventEndTs: change.eventEndTs, ...w }
          : { kind: change.kind, seriesId: change.seriesId, ...w };
    });
  } finally {
    key.privateKey.fill(0);
  }
}

/**
 * Sign `changes` and start saving them. Returns the running change, for its Cancel.
 * `view` must be fresh: the signatures commit to the nonces in it.
 */
export async function startTermsChange(
  event: EventFeed,
  parent: string,
  view: Ledger2EventView,
  changes: readonly TermsChange[],
  io: Ledger2ClientIO,
  onPhase: (p: ChangePhase) => void,
): Promise<{ change: Ledger2Change; done: Promise<void> }> {
  const signed = await signTermsChanges(view, changes, io);
  const signedAt = new Map(
    changes.map((c) => {
      const s = view.series.find((x) => x.seriesId === c.seriesId)!;
      return [c.seriesId, { nonce: s.termsNonce, key: s.organiserKey }] as const;
    }),
  );
  const change = new Ledger2Change(event, parent, changes, signed, signedAt, io, onPhase);
  return { change, done: change.run() };
}

/** Codes worth another try before the signature lapses: the request never got a verdict. */
const TRANSIENT = new Set(["rate_limited", "chain_unverified", "relay_unavailable", "relay_failed", "in_flight", "network"]);

export function isTransient(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === undefined || TRANSIENT.has(code);
}

/** Whether `changes` are what the chain now holds (a cancel: cancelled). */
export function changesPresent(view: Ledger2EventView, changes: readonly TermsChange[]): boolean {
  return changes.every((c) => {
    const s = view.series.find((x) => x.seriesId === c.seriesId);
    if (!s) return false;
    if (c.kind === "setSupply") return s.totalSupply === c.supply;
    if (c.kind === "extendSalesEnd") return s.eventEndTs === c.eventEndTs;
    if (c.kind === "cancel") return s.cancelled;
    return true;
  });
}

export type ChangePhase =
  | { phase: "saving" }
  | { phase: "saved" }
  /** Some series took the change, some did not (another device changed one meanwhile). */
  | { phase: "partly_saved"; landed: string[] }
  | { phase: "cancelling" }
  | { phase: "cancelled" }
  | { phase: "already_saved" }
  | { phase: "changed_elsewhere" }
  | { phase: "failed"; message: string; code?: string };

/** Retry backoff, ms: a few quick tries, then every 20 s until the signature runs low. */
const BACKOFF = [2_000, 5_000, 10_000, 20_000];
/** Stop retrying this long before the signature's deadline. */
const STOP_BEFORE_DEADLINE_SECS = 6 * 60;
/** How long to watch the chain for a change whose receipt we did not get. */
const CONFIRM_WATCH_MS = 120_000;

/**
 * One signed change from "Saving..." to an answer, with "Cancel" while it is still
 * saving. Lives in memory only: after a reload the chain is the truth, and the
 * signature lapses within the hour.
 */
export class Ledger2Change {
  private cancelRequested = false;
  private sending: Promise<unknown> | null = null;
  private done = false;

  constructor(
    private readonly event: EventFeed,
    private readonly parent: string,
    private readonly changes: readonly TermsChange[],
    private readonly signed: readonly Ledger2RelayItem[],
    /** The nonce and organiser key each series' signature was made at. */
    private readonly signedAt: ReadonlyMap<string, { nonce: bigint; key: string }>,
    private readonly io: Ledger2ClientIO,
    private readonly onPhase: (p: ChangePhase) => void,
  ) {}

  /** Send, retrying what never got a verdict until the signature runs low. */
  async run(): Promise<void> {
    this.onPhase({ phase: "saving" });
    const deadline = Math.min(...this.signed.map((s) => s.deadline));
    const startedAt = Date.now();
    const chainAtStart = await this.io.chainNow().catch(() => deadline - 3600);
    const chainNow = () => chainAtStart + Math.floor((Date.now() - startedAt) / 1000);
    for (let attempt = 0; !this.cancelRequested; attempt++) {
      try {
        const p = this.io.relay(this.event.eventId, { items: [...this.signed] });
        this.sending = p;
        const result = await p;
        this.sending = null;
        if (this.cancelRequested) return; // the cancel path reads the outcome
        await this.settle(result);
        return;
      } catch (err) {
        this.sending = null;
        if (this.cancelRequested) return;
        if (!isTransient(err) || chainNow() >= deadline - STOP_BEFORE_DEADLINE_SECS) {
          await this.finishFromChain(err);
          return;
        }
        await this.io.sleep(BACKOFF[Math.min(attempt, BACKOFF.length - 1)]!);
      }
    }
  }

  private async settle(result: Ledger2RelayResult): Promise<void> {
    if (result.status === "landed") {
      const landed = this.signed.filter((_, i) => result.landed?.[i]).map((s) => s.seriesId);
      this.finish(landed.length === this.signed.length ? { phase: "saved" } : landed.length === 0 ? { phase: "changed_elsewhere" } : { phase: "partly_saved", landed });
      return;
    }
    if (result.status === "unconfirmed") {
      // Sent; the receipt was slow. Watch the chain for the values.
      const until = Date.now() + CONFIRM_WATCH_MS;
      while (Date.now() < until) {
        const view = await readLedger2Event(this.event, this.parent, this.io).catch(() => null);
        if (view && changesPresent(view, this.changes)) {
          this.finish({ phase: "saved" });
          return;
        }
        await this.io.sleep(5_000);
      }
    }
    await this.finishFromChain(null);
  }

  /** No clean answer from the relay: the chain says what happened. */
  private async finishFromChain(err: unknown): Promise<void> {
    const view = await readLedger2Event(this.event, this.parent, this.io).catch(() => null);
    if (view && changesPresent(view, this.changes)) {
      this.finish({ phase: "saved" });
      return;
    }
    this.finish({
      phase: "failed",
      message: messageFor(err),
      ...((err as { code?: string })?.code ? { code: (err as { code: string }).code } : {}),
    });
  }

  /**
   * "Cancel": stop retrying, then sign a revoke at the same nonce and send it. Whichever
   * lands first wins; afterwards the chain says which.
   */
  async cancel(): Promise<void> {
    if (this.done || this.cancelRequested) return;
    this.cancelRequested = true;
    this.onPhase({ phase: "cancelling" });
    // A request already on its way cannot be called back; its answer decides first.
    if (this.sending) {
      try {
        const result = (await this.sending) as Ledger2RelayResult;
        if (result.status === "landed") {
          this.finish({ phase: "already_saved" });
          return;
        }
      } catch {
        // fall through to the revoke
      }
    }
    try {
      const view = await readLedger2Event(this.event, this.parent, this.io);
      if (!view) throw new Ledger2ChangeError("Couldn't read your event just now.", "network");
      const ours = view.series.filter((s) => this.signedAt.has(s.seriesId));
      // A key move bumps the nonce too, so it is checked first: it is not "changed
      // elsewhere", it is this device being behind its own account.
      if (ours.some((s) => s.organiserKey !== this.signedAt.get(s.seriesId)!.key)) {
        throw new Ledger2ChangeError("", "key_moved");
      }
      if (ours.some((s) => s.termsNonce !== this.signedAt.get(s.seriesId)!.nonce)) {
        this.finish(changesPresent(view, this.changes) ? { phase: "already_saved" } : { phase: "changed_elsewhere" });
        return;
      }
      const revokes = await signTermsChanges(view, ours.map((s) => ({ kind: "revoke" as const, seriesId: s.seriesId })), this.io);
      for (let attempt = 0; ; attempt++) {
        try {
          await this.io.relay(this.event.eventId, { items: revokes });
          this.finish({ phase: "cancelled" });
          return;
        } catch (err) {
          if ((err as { code?: string })?.code === "nonce_moved") break;
          if (!isTransient(err) || attempt >= 3) throw err;
          await this.io.sleep(BACKOFF[attempt]!);
        }
      }
      const after = await readLedger2Event(this.event, this.parent, this.io);
      this.finish(after && changesPresent(after, this.changes) ? { phase: "already_saved" } : { phase: "changed_elsewhere" });
    } catch (err) {
      if ((err as { code?: string })?.code === "key_moved") {
        this.finish({ phase: "failed", message: "Your account's keys changed on another device. Reload this page.", code: "key_moved" });
        return;
      }
      this.finish({
        phase: "failed",
        message: "Couldn't cancel just now. If the change is still saving it may go through within the hour - check back here.",
        code: "cancel_failed",
      });
    }
  }

  private finish(p: ChangePhase): void {
    this.done = true;
    this.onPhase(p);
  }
}

/** The organiser-facing sentence for a relay refusal. No chain words. */
export function messageFor(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  const body = (err as { body?: Record<string, unknown> })?.body ?? {};
  switch (code) {
    case "supply_below_sold_or_held": {
      const min = typeof body.minSupply === "number" ? body.minSupply : null;
      const until = typeof body.holdsExpireBy === "string" ? new Date(body.holdsExpireBy) : null;
      const held = typeof body.held === "number" ? body.held : 0;
      if (held > 0 && until) {
        return `${held} ticket(s) are in buyers' baskets right now. The lowest you can set is ${min ?? "the number sold plus those"}, or try again after ${until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
      }
      return `You've already sold ${body.sold ?? "that many"} - the lowest you can set is ${min ?? "that number"}.`;
    }
    case "supply_above_registered":
      return `This ticket type can go up to ${body.max ?? "the number it was published with"}. For more, add a new ticket type.`;
    case "supply_unchanged":
      return "That's already the number on sale.";
    case "sales_closed":
      return "Ticket sales for this event have ended, so this can't be changed any more.";
    case "event_cancelled":
    case "already_cancelled":
      return "This event has been cancelled.";
    case "sales_end_not_later":
      return "Sales already run that late.";
    case "sales_end_too_far":
      return "That date is too far ahead - choose one within two years.";
    case "signature_stale":
    case "nonce_moved":
      return "Your event was changed somewhere else in the meantime. Reload and try again.";
    case "key_moved":
      return "Your account's keys changed on another device. Reload this page.";
    case "rate_limited":
      return "Too many changes in a short time. Try again in a little while.";
    case "not_available":
      return "This event's tickets can't be changed here.";
    case "digest_mismatch":
      return (err as Error).message;
    default:
      return "Couldn't save the change just now. Nothing was changed - try again in a moment.";
  }
}
