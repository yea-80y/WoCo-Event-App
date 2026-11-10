/**
 * Etherna upload helpers — raw HTTP against gateway.etherna.io.
 *
 * We bypass bee-js here because bee-js v11's onRequest header injection is
 * shallow-copy and unreliable, and the offer-register step is Etherna-specific
 * and has no bee-js wrapper. The signed feed writers that send through
 * `postSocToEtherna` live in `soc-send.ts`, with the failover (#912).
 */

import { Binary } from "cafe-utility";
import { calculateSocAddress } from "@woco/shared";
import { ensureEthernaToken, getCachedEthernaToken } from "./auth.js";
import { ETHERNA_FETCH_BASE } from "./gateway.js";
import { errorSnippet } from "../http/read-capped.js";
import { BEE_CALL_TIMEOUT_MS } from "../swarm/upload-queue.js";
import { noteEthernaFailure } from "./breaker.js";
import { noteEthernaSend } from "./relay-ledger.js";

const ETHERNA_GW = ETHERNA_FETCH_BASE;

/**
 * Register an Etherna "offer" so the resource becomes anonymously readable
 * via /bytes/{ref} (and /bzz/{ref}/file for collection entries).
 * Anonymous /feeds reads are NOT covered by offers — that endpoint always 401s.
 * Bounded (#912): callers await it on a save's path, and an offers API that hangs
 * must not hold a deploy (and its deploy guard) with it.
 */
export const OFFER_TIMEOUT_MS = 10_000;

export async function registerEthernaOffer(ref: string): Promise<void> {
  await ensureEthernaToken();
  const token = getCachedEthernaToken();
  if (!token) throw new Error("Etherna token unavailable");
  const r = await fetch(`${ETHERNA_GW}/api/v0.3/resources/${ref}/offers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(OFFER_TIMEOUT_MS),
  });
  if (!r.ok && r.status !== 409) {
    // 409 = already offered; treat as success
    throw new Error(`Etherna offer-register failed ${r.status}: ${await errorSnippet(r, 200)}`);
  }
}

/**
 * POST one signed SOC to Etherna: `/soc/{owner}/{id}?sig=`, body = span || payload.
 *
 * THE ONLY WAY THIS SERVER SENDS A SOC THERE (#912). The address is listed in the
 * relay ledger BEFORE the request leaves, and the read rule that lets our bee's
 * 404 decide during an Etherna outage is exact only because nothing reaches
 * Etherna's store unlisted (`test/etherna-failover.test.ts` fails on a second
 * sender). A slow failure pauses Etherna for reads and the relay alike.
 *
 * Throws `Error & { status }` on a non-2xx (the HTTP status), plain on a timeout
 * or network fault.
 */
export async function postSocToEtherna(opts: {
  ownerHex: string;
  identifierHex: string;
  sigHex: string;
  body: Uint8Array;
  batchId: string;
  timeoutMs?: number;
}): Promise<void> {
  const owner = opts.ownerHex.toLowerCase().replace(/^0x/, "");
  const address = Binary.uint8ArrayToHex(
    calculateSocAddress(Binary.hexToUint8Array(opts.identifierHex), Binary.hexToUint8Array(owner)),
  );
  noteEthernaSend(address, owner, opts.identifierHex);
  const started = performance.now();
  try {
    await ensureEthernaToken();
    const token = getCachedEthernaToken();
    if (!token) throw new Error("Etherna token unavailable");
    const res = await fetch(`${ETHERNA_GW}/soc/${owner}/${opts.identifierHex}?sig=${opts.sigHex}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Swarm-Postage-Batch-Id": opts.batchId,
        Authorization: `Bearer ${token}`,
      },
      // @ts-ignore — Node 18 fetch duplex
      duplex: "half",
      body: Buffer.from(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? BEE_CALL_TIMEOUT_MS),
    });
    if (!res.ok) {
      const err = new Error(`Etherna SOC write ${res.status}: ${await errorSnippet(res, 200)}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
  } catch (err) {
    noteEthernaFailure(`etherna write: ${(err as Error)?.message ?? String(err)}`, started);
    throw err;
  }
}
