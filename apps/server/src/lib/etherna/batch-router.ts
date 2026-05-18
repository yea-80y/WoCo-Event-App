/**
 * Decide which postage batch + upload target a given deploy should use.
 *
 * Rules (locked 2026-05-18, see docs/REALIGNMENT_2026-05-18_v2.md):
 *   - WoCo gateway picked → always platform woco batch (testing escape hatch).
 *   - Etherna gateway + user has a batch → reuse it (covers websites AND events).
 *   - Etherna gateway + no user batch + event deploy → fall back to shared
 *     ETHERNA_PLATFORM_BATCH (events never trigger a purchase).
 *   - Etherna gateway + no user batch + website deploy → throw. UI must call
 *     POST /api/etherna/purchase-batch before retrying.
 */

import { POSTAGE_BATCH_ID } from "../../config/swarm.js";
import { getUserBatch } from "./batches.js";

export type DeployType = "event" | "website";
export type UploadTarget = "wocoBee" | "etherna";

export interface BatchSelection {
  batchId: string;
  target: UploadTarget;
}

const ETHERNA_URL = process.env.ETHERNA_GATEWAY_URL || "https://gateway.etherna.io";
const WOCO_URL = "https://gateway.woco-net.com";

export class BatchPurchaseRequired extends Error {
  constructor() {
    super("Etherna website deploy requires a user batch. Call POST /api/etherna/purchase-batch first.");
    this.name = "BatchPurchaseRequired";
  }
}

function isEthernaGateway(url: string): boolean {
  try {
    return new URL(url).host.endsWith(new URL(ETHERNA_URL).host);
  } catch {
    return url === ETHERNA_URL;
  }
}

function isWocoGateway(url: string): boolean {
  try {
    return new URL(url).host.endsWith(new URL(WOCO_URL).host);
  } catch {
    return url === WOCO_URL;
  }
}

interface RouterInput {
  ownerAddress: string;
  gatewayUrl: string;
  deployType: DeployType;
}

export function batchForDeploy(input: RouterInput): BatchSelection {
  const { ownerAddress, gatewayUrl, deployType } = input;

  if (isWocoGateway(gatewayUrl) || !isEthernaGateway(gatewayUrl)) {
    if (!POSTAGE_BATCH_ID) {
      throw new Error("POSTAGE_BATCH_ID not configured — cannot deploy via WoCo gateway");
    }
    return { batchId: POSTAGE_BATCH_ID, target: "wocoBee" };
  }

  const user = getUserBatch(ownerAddress);
  if (user) {
    return { batchId: user.batchId, target: "etherna" };
  }

  if (deployType === "event") {
    const platform = process.env.ETHERNA_PLATFORM_BATCH;
    if (!platform) {
      throw new Error("ETHERNA_PLATFORM_BATCH not configured — cannot fall back for event deploy");
    }
    return { batchId: platform, target: "etherna" };
  }

  throw new BatchPurchaseRequired();
}
