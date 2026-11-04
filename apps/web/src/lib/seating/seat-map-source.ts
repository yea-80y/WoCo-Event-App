/**
 * Where a buyer's seat map reads from, in the app and on organisers' websites
 * (docs/SEATING.md decision 6): our gateway for the manifest and plan (Etherna sends
 * no CORS), the ledger2 deployment on the Kernel chain through a public RPC, our API
 * for live holds. An RPC origin here must also be in the app's CSP `connect-src`
 * (vite-plugins/csp.ts); organiser sites carry no CSP.
 *
 * One load per series per page: the ticket card's thumbnail and the picker share it.
 */

import { KERNEL_CHAIN_ID } from "@woco/shared/kernel/chain";
import { ticketLedger2Address } from "@woco/shared/ticket/ledger2";
import type { SeriesSummary } from "@woco/shared";
import { buildEnv } from "../build-env.js";
import { WOCO_GATEWAY_URL } from "../swarm/gateways.js";

const PUBLIC_RPC: Record<number, string> = {
  42161: "https://arb1.arbitrum.io/rpc",
  421614: "https://sepolia-rollup.arbitrum.io/rpc",
};

/** The RPC the map reads the ledger through: a build override (a read cache), else the chain's public RPC. */
export function seatMapRpcUrl(): string | null {
  const override = buildEnv(() => import.meta.env.VITE_SEATMAP_RPC as string | undefined)?.trim();
  return override || PUBLIC_RPC[KERNEL_CHAIN_ID] || null;
}

/** The series the map can be drawn for: seated, registered, with its manifest named. */
export function seatedSeriesReady(s: SeriesSummary): s is SeriesSummary & Required<Pick<SeriesSummary, "seating" | "onChainEventId" | "swarmManifestRef">> {
  return !!s.seating && !!s.onChainEventId && !!s.swarmManifestRef;
}

type Loaded = Awaited<ReturnType<typeof import("@woco/seatmap/load").loadSeatMap>>;
const loads = new Map<string, Promise<Loaded>>();

/**
 * The seat map for a series, loaded once per page (the renderer and loader are a
 * lazily loaded chunk: a general-admission page never downloads them). A failed or
 * refused load is forgotten, so opening the map again tries again.
 */
export function seatMapFor(eventId: string, series: SeriesSummary, apiUrl: string): Promise<Loaded> {
  const key = `${eventId}\u0000${series.seriesId}`;
  let p = loads.get(key);
  if (!p) {
    p = (async (): Promise<Loaded> => {
      const ledger = ticketLedger2Address(KERNEL_CHAIN_ID);
      const rpcUrl = seatMapRpcUrl();
      if (!ledger || !rpcUrl || !seatedSeriesReady(series)) return { ok: false, problem: "not-seated" };
      const { loadSeatMap } = await import("@woco/seatmap/load");
      return loadSeatMap(
        {
          eventId, seriesId: series.seriesId, onChainEventId: series.onChainEventId,
          swarmManifestRef: series.swarmManifestRef, seating: series.seating,
        },
        { fetch: (input, init) => fetch(input, init), gatewayUrl: WOCO_GATEWAY_URL, rpcUrl, apiUrl, ledger },
      );
    })();
    loads.set(key, p);
    p.then((r) => { if (!r.ok) loads.delete(key); }, () => loads.delete(key));
  }
  return p;
}
