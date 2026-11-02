/**
 * Knowing whether a card-sale mint landed before refunding it (#994).
 *
 * Fulfilment used to read ANY failure of the mint call as "this chunk rolled
 * back" and refund it. Some failures come after the node already has the
 * transaction: a timeout or 5xx on the raw send, ethers' "already known", or a
 * receipt wait that dies on an RPC blip (and `wait()` with no timeout could hang
 * fulfilment for good). If such a mint lands, its slots belong to burners whose
 * keys were discarded with the refund, so those seats are gone.
 *
 * So the mint is split by PHASE, not by the shape of the error:
 *  - before the raw send (block read, populate, gas estimate, sign) nothing has
 *    been broadcast, so a failure is definitive and refunds as before;
 *  - from the raw send on, the outcome is read from the chain, never assumed:
 *    the receipt of the hash (known before broadcast, because we sign it) is the
 *    fast path, and `SlotClaimed` logs filtered by this sale's burner addresses
 *    are the authority. Burners are fresh random keys per sale, so those logs
 *    name exactly this sale's slots whichever transaction carried them.
 *
 * Slots are mapped by owner, never by log order: burner i signs edition
 * slot_i + 1, and a mismatch would make that ticket fail at the door.
 *
 * Still unknown after the bound: the caller refunds (today's behaviour), and
 * the attempt is logged so a later landing can be found. Holding the money
 * instead only pays once a landed-but-unsigned slot can be repaired, which
 * needs `reissue` (WoCoTicketLedger version 2, #983 step 5) - the live
 * contract has none.
 */

import { Interface, zeroPadValue } from "ethers";

/** Long enough to outlast an RPC blip or replica lag many times over: Arbitrum includes in under a second. */
export const MINT_RESOLVE_BOUND_MS = 10 * 60_000;
export const MINT_RESOLVE_POLL_MS = 2_000;

const SLOT_CLAIMED = new Interface([
  "event SlotClaimed(bytes32 indexed eventId, uint256 indexed slot, address indexed owner, address claimer, bytes32 orderRef)",
]);
const SLOT_CLAIMED_TOPIC = SLOT_CLAIMED.getEvent("SlotClaimed")!.topicHash;

export interface MintLog {
  address: string;
  topics: readonly string[];
  data: string;
}

export interface MintReceipt {
  /** 1 = executed, 0 = reverted (null only for pre-Byzantium receipts). */
  status: number | null;
  logs: readonly MintLog[];
}

export interface MintLogFilter {
  address: string;
  topics: Array<string | string[] | null>;
  fromBlock: number;
  toBlock: "latest";
}

export interface MintResolveIo {
  getReceipt(hash: string): Promise<MintReceipt | null>;
  getLogs(filter: MintLogFilter): Promise<readonly MintLog[]>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface MintAttempt {
  /** Hash of the signed transaction, computed before it was broadcast. */
  hash: string;
  contract: string;
  /** 0x-prefixed bytes32 on-chain event id. */
  eventId: string;
  /** The sale's burner addresses, in the order their slots are wanted. */
  owners: readonly string[];
  /** A block read before the broadcast: the transaction cannot be in an earlier one. */
  fromBlock: number;
}

export type MintResolution =
  | { kind: "minted"; slots: number[] }
  | { kind: "not-minted"; why: string };

export class MintUnresolvedError extends Error {
  constructor(
    readonly hash: string,
    readonly owners: readonly string[],
    boundMs: number,
  ) {
    super(`mint ${hash} unresolved after ${Math.round(boundMs / 1000)} s (no receipt, no SlotClaimed for its ${owners.length} owner(s))`);
    this.name = "MintUnresolvedError";
  }
}

/**
 * Each owner's slot from `SlotClaimed` logs of `contract` for `eventId`, in
 * `owners` order; null unless every owner has one. Logs of other contracts or
 * events, and unparseable logs, are ignored.
 */
export function slotsByOwner(
  logs: readonly MintLog[],
  contract: string,
  eventId: string,
  owners: readonly string[],
): number[] | null {
  const want = contract.toLowerCase();
  const event = eventId.toLowerCase();
  const found = new Map<string, number>();
  for (const log of logs) {
    if (log.address.toLowerCase() !== want || log.topics[0] !== SLOT_CLAIMED_TOPIC) continue;
    let parsed;
    try {
      parsed = SLOT_CLAIMED.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (!parsed || String(parsed.args.eventId).toLowerCase() !== event) continue;
    found.set(String(parsed.args.owner).toLowerCase(), Number(parsed.args.slot));
  }
  const slots = owners.map((o) => found.get(o.toLowerCase()));
  return slots.every((s): s is number => s !== undefined) ? slots : null;
}

/**
 * Read a broadcast (or possibly broadcast) mint's outcome from the chain.
 * Resolves `minted` with the slots by owner, or `not-minted` only on a reverted
 * receipt for `hash` (its nonce is then spent, so nothing else of ours can carry
 * this call). Throws `MintUnresolvedError` at the bound. RPC failures while
 * polling are not answers: they are retried until the bound.
 */
export async function resolveMint(
  attempt: MintAttempt,
  io: MintResolveIo,
  opts: { boundMs?: number; pollMs?: number } = {},
): Promise<MintResolution> {
  const boundMs = opts.boundMs ?? MINT_RESOLVE_BOUND_MS;
  const pollMs = opts.pollMs ?? MINT_RESOLVE_POLL_MS;
  const deadline = io.now() + boundMs;
  const filter: MintLogFilter = {
    address: attempt.contract,
    topics: [SLOT_CLAIMED_TOPIC, attempt.eventId, null, attempt.owners.map((o) => zeroPadValue(o.toLowerCase(), 32))],
    fromBlock: attempt.fromBlock,
    toBlock: "latest",
  };

  for (;;) {
    try {
      const receipt = await io.getReceipt(attempt.hash);
      if (receipt?.status === 0) return { kind: "not-minted", why: `transaction ${attempt.hash} reverted` };
      if (receipt?.status === 1) {
        const slots = slotsByOwner(receipt.logs, attempt.contract, attempt.eventId, attempt.owners);
        if (slots) return { kind: "minted", slots };
        // Executed but not readable from the receipt: a parse or provider defect,
        // not a chain fact. The log query below is the authority.
      }
    } catch {
      // not an answer
    }
    try {
      const slots = slotsByOwner(await io.getLogs(filter), attempt.contract, attempt.eventId, attempt.owners);
      if (slots) return { kind: "minted", slots };
    } catch {
      // not an answer
    }
    if (io.now() >= deadline) throw new MintUnresolvedError(attempt.hash, attempt.owners, boundMs);
    await io.sleep(pollMs);
  }
}

/** Nonce override handed to the send closure by the sponsor nonce queue. */
export interface MintNonce {
  nonce: number;
}

export type MintBroadcast =
  /** The node took the transaction. */
  | { kind: "sent"; hash: string; fromBlock: number }
  /** The raw send was attempted and failed in a way that does not prove the node refused it. */
  | { kind: "ambiguous"; hash: string; fromBlock: number; err: unknown }
  /** Nothing was broadcast, or the node definitively refused it: the chain cannot carry this mint. */
  | { kind: "refused"; err: unknown };

/**
 * Prepare (block read, populate, estimate, sign) and broadcast one mint through
 * the sponsor nonce queue, reporting which phase a failure came from.
 * `isRefusal` names the raw-send errors that prove the node did not take the
 * transaction (nonce already used, replacement underpriced, insufficient funds).
 */
export async function broadcastMint(io: {
  queue(send: (o: MintNonce) => Promise<string>): Promise<string>;
  prepare(o: MintNonce): Promise<{ signed: string; hash: string; fromBlock: number }>;
  sendRaw(signed: string): Promise<unknown>;
  isRefusal(err: unknown): boolean;
}): Promise<MintBroadcast> {
  let attempt: { hash: string; fromBlock: number } | null = null;
  try {
    await io.queue(async (o) => {
      // The queue retries only after the node refused the previous try, so each
      // try starts with nothing broadcast.
      attempt = null;
      const p = await io.prepare(o);
      attempt = { hash: p.hash, fromBlock: p.fromBlock };
      await io.sendRaw(p.signed);
      return p.hash;
    });
  } catch (err) {
    const sent = attempt as { hash: string; fromBlock: number } | null;
    if (!sent || io.isRefusal(err)) return { kind: "refused", err };
    return { kind: "ambiguous", hash: sent.hash, fromBlock: sent.fromBlock, err };
  }
  const sent = attempt as { hash: string; fromBlock: number } | null;
  if (!sent) throw new Error("broadcastMint: the queue resolved without running the send");
  return { kind: "sent", hash: sent.hash, fromBlock: sent.fromBlock };
}
