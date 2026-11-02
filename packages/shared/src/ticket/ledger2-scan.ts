/**
 * An account's events on ledger v2, found from the chain alone - no platform index, no
 * server (#186 removal, Fable design consult 2026-11-01). The candidates are every
 * `Registered` log naming the account as organiser AND registered by someone whose
 * registrations are real:
 *   - an address the ledger's owner ever added as a sponsor (`SponsorAdded`, ever, not
 *     now: a sponsor removed later still registered real events), or
 *   - the account itself (an organiser registering its own events).
 * Registration is permissionless and names its organiser freely, so the registrant is
 * the filter: anyone can register junk naming a victim, but `registrant` is the
 * caller and cannot be forged. Junk left on an old key is harmless - never sold, it
 * controls only itself - while moving it would spend the account's sponsored gas.
 * `organiser` is immutable after registration, so this list is complete by
 * construction; a filter on the KEY would need every past generation's key.
 *
 * Logs are history, not state: the caller re-reads each id live before moving it.
 *
 * Never a partial list passed off as whole: a page that cannot be read (after the IO's
 * own endpoint fallback) makes the result `complete: false`, with what WAS read.
 */
import { logScanWindows } from "../chain/log-windows.js";

const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;

export interface OrganiserEventScanIO {
  /** One page of `SponsorAdded` logs: the sponsor addresses. Throws when the page cannot be read. */
  sponsorsAdded(fromBlock: number, toBlock: number): Promise<string[]>;
  /**
   * One page of `Registered` logs naming `organiser` and registered by any of
   * `registrants` (one query: the topic takes an OR-list). Their event ids. Throws
   * when the page cannot be read.
   */
  registered(organiser: string, registrants: readonly string[], fromBlock: number, toBlock: number): Promise<string[]>;
}

export interface OrganiserEventScan {
  /** Lowercase event ids, each once. */
  ids: string[];
  /** False when any page could not be read: `ids` is then what was found, not all. */
  complete: boolean;
}

/** Every event `organiser` has on the ledger, scanned from `fromBlock` to ONE `head` snapshot. */
export async function scanOrganiserEvents(
  io: OrganiserEventScanIO,
  organiser: string,
  fromBlock: number,
  head: number,
): Promise<OrganiserEventScan> {
  const o = organiser.toLowerCase();
  const windows = logScanWindows(fromBlock, head);
  let complete = true;

  const registrants = new Set<string>([o]);
  for (const [from, to] of windows) {
    try {
      for (const s of await io.sponsorsAdded(from, to)) {
        const v = s.toLowerCase();
        if (ADDRESS.test(v)) registrants.add(v);
      }
    } catch {
      // A sponsor missed here would hide that sponsor's registrations below.
      complete = false;
    }
  }

  const ids = new Set<string>();
  const filter = [...registrants];
  for (const [from, to] of windows) {
    try {
      for (const id of await io.registered(o, filter, from, to)) {
        const v = id.toLowerCase();
        if (BYTES32.test(v)) ids.add(v);
      }
    } catch {
      complete = false;
    }
  }
  return { ids: [...ids], complete };
}
