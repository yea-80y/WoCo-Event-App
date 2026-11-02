/**
 * The account's ledger v2 events, from the chain (`@woco/shared/ticket/ledger2-scan`):
 * the browser's wiring of that scan to the same RPCs the owner scan trusts
 * (`ownerScanRpcUrls`: the ZeroDev RPC every Kernel read uses, then the public one).
 * A page is tried on each endpoint in turn; one that fails on all of them marks the
 * scan incomplete, never empty. Loaded on the removal path only.
 */
import type { OrganiserEventScan, OrganiserEventScanIO } from "@woco/shared/ticket/ledger2-scan";
import type { Ledger2Deployment, OrganiserKeyEventState } from "@woco/shared/ticket/ledger2";

/** The two calls the scan makes of a client: viem's `getBlockNumber` and `getLogs`. */
export interface ScanClient {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: {
    address: `0x${string}`;
    event: unknown;
    args?: Record<string, unknown>;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<Array<{ args: Record<string, unknown> }>>;
}

/** The scan's IO over `clients` in order, for the ledger at `ledger`. */
export async function organiserEventScanIO(ledger: string, clients: readonly ScanClient[]): Promise<OrganiserEventScanIO> {
  const [{ parseAbiItem }, { LEDGER2_REGISTERED_EVENT, LEDGER2_SPONSOR_ADDED_EVENT }] = await Promise.all([
    import("viem"),
    import("@woco/shared/ticket/ledger2"),
  ]);
  const address = ledger as `0x${string}`;
  const registered = parseAbiItem(LEDGER2_REGISTERED_EVENT);
  const sponsorAdded = parseAbiItem(LEDGER2_SPONSOR_ADDED_EVENT);

  // The highest head each endpoint has shown: an endpoint behind `to` is asked again,
  // never trusted for the page.
  const seen = new Map<ScanClient, bigint>();

  /**
   * One page from the first endpoint that has reached `to` and answers. Checked BEFORE
   * the read: a node behind the page's end serves the logs it has with no error, and a
   * short page would read as a whole one (Fable sign-off 2026-11-02).
   */
  async function page<T>(to: number, read: (c: ScanClient) => Promise<T>): Promise<T> {
    let lastErr: unknown = new Error(`no endpoint has reached block ${to}`);
    for (const c of clients) {
      try {
        if ((seen.get(c) ?? -1n) < BigInt(to)) {
          const head = await c.getBlockNumber();
          seen.set(c, head);
          if (head < BigInt(to)) {
            lastErr = new Error(`endpoint at block ${head}, page ends at ${to}`);
            continue;
          }
        }
        return await read(c);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  return {
    sponsorsAdded: (from, to) =>
      page(to, async (c) => {
        const logs = await c.getLogs({ address, event: sponsorAdded, fromBlock: BigInt(from), toBlock: BigInt(to) });
        return logs.map((l) => String(l.args.sponsor ?? ""));
      }),
    registered: (organiser, registrants, from, to) =>
      page(to, async (c) => {
        const logs = await c.getLogs({
          address,
          event: registered,
          args: { organiser, registrant: [...registrants] },
          fromBlock: BigInt(from),
          toBlock: BigInt(to),
        });
        return logs.map((l) => String(l.args.eventId ?? ""));
      }),
  };
}

/** The head every page of one scan stops at, from the first endpoint that answers. */
async function headOf(clients: readonly ScanClient[]): Promise<number> {
  let lastErr: unknown;
  for (const c of clients) {
    try {
      return Number(await c.getBlockNumber());
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Every event `organiser` has on `deployment`. Incomplete (never thrown) when the chain
 * cannot be read at all, so a caller that may proceed on a partial list can.
 */
export async function scanOwnLedger2Events(
  organiser: string,
  deployment: Ledger2Deployment,
  clients?: readonly ScanClient[],
): Promise<OrganiserEventScan> {
  const { scanOrganiserEvents } = await import("@woco/shared/ticket/ledger2-scan");
  const cs = clients ?? (await defaultClients());
  try {
    const head = await headOf(cs);
    return await scanOrganiserEvents(await organiserEventScanIO(deployment.address, cs), organiser, deployment.deployBlock, head);
  } catch (e) {
    console.warn("[keyring] could not read your events onchain:", e);
    return { ids: [], complete: false };
  }
}

/**
 * The ledger v2 this build moves organiser keys on: the shared table, else - where it is
 * empty (dev, sandbox) - the ledger this build's server registers on, as `address` or
 * `address:deployBlock` in VITE_WOCO_LEDGER2_ADDRESS (`parseLedger2Override`).
 */
export async function ownLedger2Deployment(): Promise<Ledger2Deployment | null> {
  const [{ ticketLedger2Deployment, parseLedger2Override }, { KERNEL_CHAIN_ID }] = await Promise.all([
    import("@woco/shared/ticket/ledger2"),
    import("@woco/shared/kernel/chain"),
  ]);
  return (
    ticketLedger2Deployment(KERNEL_CHAIN_ID) ??
    parseLedger2Override(import.meta.env.VITE_WOCO_LEDGER2_ADDRESS as string | undefined)
  );
}

/** The two reads `organiserKeysDue` makes - the live ones, or a test's. */
export interface OrganiserKeysDueIO {
  scan(organiser: string, deployment: Ledger2Deployment): Promise<OrganiserEventScan>;
  states(ledger: string, ids: string[]): Promise<OrganiserKeyEventState[] | "error">;
}

const liveDueIO: OrganiserKeysDueIO = {
  scan: (organiser, deployment) => scanOwnLedger2Events(organiser, deployment),
  states: async (ledger, ids) => (await import("../auth/kernel-account.js")).readOrganiserKeyStates(ledger, ids),
};

/**
 * The account's events on `deployment` not yet on `key`, in the order to move them:
 * found from the chain (plus `extraIds`, which only add), each re-read live, and
 * `planOrganiserKeyMoves` decides.
 *
 * POLARITY. `strict` false (before a removal's flip): nothing here stops the removal - an
 * unreadable chain carries what was found, or nothing, since refusing would leave the
 * removed passkey in charge of the whole account. `strict` true (every later catch-up):
 * throws unless the WHOLE chain was read, so the work is never counted done on a partial
 * read.
 */
export async function organiserKeysDue(
  parent: string,
  key: string,
  deployment: Ledger2Deployment,
  opts: { strict: boolean; extraIds?: readonly string[] },
  io: OrganiserKeysDueIO = liveDueIO,
): Promise<{ ledger: string; ids: string[] }> {
  const scan = await io.scan(parent, deployment);
  if (opts.strict && !scan.complete) throw new Error("Couldn't read all of your events onchain - will retry.");
  const ids = new Set([...scan.ids, ...(opts.extraIds ?? [])]);
  const states = await io.states(deployment.address, [...ids]);
  if (states === "error") {
    if (opts.strict) throw new Error("Couldn't read your events onchain - will retry.");
    return { ledger: deployment.address, ids: [] };
  }
  const { planOrganiserKeyMoves } = await import("@woco/shared/ticket/ledger2");
  return { ledger: deployment.address, ids: planOrganiserKeyMoves(states, parent, key, Date.now() / 1000) };
}

async function defaultClients(): Promise<ScanClient[]> {
  const [{ createPublicClient, http }, { ownerScanRpcUrls }, { KERNEL_CHAIN }] = await Promise.all([
    import("viem"),
    import("../auth/owned-accounts-scan.js"),
    import("../auth/kernel-account.js"),
  ]);
  return ownerScanRpcUrls().map(
    (url) => createPublicClient({ chain: KERNEL_CHAIN, transport: http(url, { timeout: 60_000 }) }) as unknown as ScanClient,
  );
}
