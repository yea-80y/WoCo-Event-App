/**
 * The account's ledger v2 events, from the chain (`@woco/shared/ticket/ledger2-scan`):
 * the browser's wiring of that scan to the same RPCs the owner scan trusts
 * (`ownerScanRpcUrls`: the ZeroDev RPC every Kernel read uses, then the public one).
 * A page is tried on each endpoint in turn; one that fails on all of them marks the
 * scan incomplete, never empty. Loaded on the removal path only.
 */
import type { OrganiserEventScan, OrganiserEventScanIO } from "@woco/shared/ticket/ledger2-scan";
import type { Ledger2Deployment } from "@woco/shared/ticket/ledger2";

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

  async function page<T>(read: (c: ScanClient) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (const c of clients) {
      try {
        return await read(c);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  return {
    sponsorsAdded: (from, to) =>
      page(async (c) => {
        const logs = await c.getLogs({ address, event: sponsorAdded, fromBlock: BigInt(from), toBlock: BigInt(to) });
        return logs.map((l) => String(l.args.sponsor ?? ""));
      }),
    registered: (organiser, registrants, from, to) =>
      page(async (c) => {
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
