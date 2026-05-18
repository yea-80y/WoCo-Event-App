/**
 * Etherna upload helpers — raw HTTP against gateway.etherna.io.
 *
 * We bypass bee-js here because (a) the upload is a one-shot tar POST,
 * (b) bee-js v11's onRequest header injection is shallow-copy and unreliable,
 * and (c) the offer-register step is Etherna-specific and has no bee-js wrapper.
 *
 * Feed writes still go through bee-js (signing is the value-add), via a Bee
 * instance configured to talk to Etherna with bearer-token auth.
 */

import { Bee } from "@ethersphere/bee-js";
import { ensureEthernaToken, getCachedEthernaToken } from "./auth.js";

const ETHERNA_GW = process.env.ETHERNA_GATEWAY_URL || "https://gateway.etherna.io";

let _ethernaBee: Bee | null = null;

/**
 * Bee client targeted at Etherna with OAuth bearer injection per request.
 * Use for feed writes (uploadPayload / uploadReference / createFeedManifest)
 * when the deploy target is Etherna. The platform Bee in config/swarm.ts is
 * for the WoCo woco-batch path.
 */
export function getEthernaBee(): Bee {
  if (_ethernaBee) return _ethernaBee;
  _ethernaBee = new Bee(ETHERNA_GW, {
    onRequest: (req) => {
      const token = getCachedEthernaToken();
      if (token) {
        req.headers = { ...(req.headers ?? {}), Authorization: `Bearer ${token}` };
      }
    },
  });
  return _ethernaBee;
}

export interface BzzUploadOpts {
  batchId: string;
  tarData: Uint8Array | Buffer;
  indexDocument: string;
  errorDocument?: string;
}

/** Upload a tar collection to Etherna /bzz with bearer auth. Returns content ref. */
export async function uploadCollectionToEtherna(opts: BzzUploadOpts): Promise<string> {
  await ensureEthernaToken();
  const token = getCachedEthernaToken();
  if (!token) throw new Error("Etherna token unavailable (ETHERNA_API_KEY missing or ETHERNA_ENABLED off)");

  const headers: Record<string, string> = {
    "Content-Type": "application/x-tar",
    "Swarm-Postage-Batch-Id": opts.batchId,
    "Swarm-Index-Document": opts.indexDocument,
    "Swarm-Error-Document": opts.errorDocument ?? opts.indexDocument,
    "Swarm-Collection": "true",
    Authorization: `Bearer ${token}`,
  };

  const resp = await fetch(`${ETHERNA_GW}/bzz`, {
    method: "POST",
    headers,
    // @ts-ignore — Node 18 fetch doesn't expose duplex in type defs
    duplex: "half",
    body: opts.tarData as unknown as BodyInit,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Etherna /bzz upload failed ${resp.status}: ${text.slice(0, 300)}`);
  }
  const { reference } = await resp.json() as { reference: string };
  return reference;
}

/**
 * Register an Etherna "offer" so the resource becomes anonymously readable
 * via /bytes/{ref} (and /bzz/{ref}/file for collection entries).
 * Anonymous /feeds reads are NOT covered by offers — that endpoint always 401s.
 */
export async function registerEthernaOffer(ref: string): Promise<void> {
  await ensureEthernaToken();
  const token = getCachedEthernaToken();
  if (!token) throw new Error("Etherna token unavailable");
  const r = await fetch(`${ETHERNA_GW}/api/v0.3/resources/${ref}/offers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok && r.status !== 409) {
    // 409 = already offered; treat as success
    const text = await r.text().catch(() => "");
    throw new Error(`Etherna offer-register failed ${r.status}: ${text.slice(0, 200)}`);
  }
}
