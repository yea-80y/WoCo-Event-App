/**
 * Smoke test: full standalone POD issuance (Item A) via the same server path
 * the create-POD UI uses. Builds + ed25519-signs a manifest exactly as the
 * client does (throwaway key), then calls issuePodType — exercising manifest
 * validation → Swarm upload (pod bodies + SeriesManifestBlob) → sponsor
 * on-chain register → creator-directory upsert.
 *
 * SIDE EFFECTS (real): writes a few chunks to the live bee, sends one
 * registerEvent tx on Arb Sepolia (sponsor gas), and writes a junk POD
 * directory feed under the throwaway creator address below. Needs the dev bee
 * tunnel up (BEE_URL reachable) and a funded sponsor wallet.
 *
 * Run from repo root (tunnel running):
 *   WOCO_EVENT_CHAIN_ID=421614 node --import tsx \
 *     apps/server/scripts/pod-issuance-smoke.ts
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { ed25519 } from "@noble/curves/ed25519";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "../.env") });

const { buildPodTree, signManifest, bytesToHex0x } = await import("@woco/shared");
type SharedTypes = typeof import("@woco/shared");
const { issuePodType } = await import("../src/lib/pod/issuance.js");
const { getActiveChainId, getEventContractVersion } = await import("../src/lib/chain/event-contract.js");

// A fixed throwaway creator so re-runs upsert the same junk directory feed.
const CREATOR = "0x000000000000000000000000000000000000dead";

async function main() {
  const chainId = getActiveChainId();
  console.log(`chainId=${chainId} version=${getEventContractVersion(chainId)}`);
  if (getEventContractVersion(chainId) !== "v2") {
    console.warn(`!!! active chain ${chainId} is not V2 — issuance will reject. Set WOCO_EVENT_CHAIN_ID=421614`);
  }

  // ── ed25519 POD key (throwaway) ──────────────────────────────────────────
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  const issuer = Buffer.from(pub).toString("hex"); // lowercase, no 0x

  const supply = 3;
  const seriesId = crypto.randomUUID();
  // eventId in the pod body is informational (the authoritative id is emitted
  // on-chain) — a placeholder bytes32 keeps the body well-formed.
  const placeholderEventId = "0x" + "11".repeat(32);

  const podBodies: SharedTypes["PodV2Body"][] = Array.from({ length: supply }, (_, i) => ({
    format: "woco.ticket.v2",
    eventId: placeholderEventId,
    seriesId,
    edition: i + 1,
    metadata: { name: "Smoke Test Badge", description: "issuance smoke test", mintedAt: new Date().toISOString() },
    issuer,
  }));

  const { root } = buildPodTree(podBodies);
  const manifestBody: SharedTypes["ManifestV1Body"] = {
    format: "woco.manifest.v1",
    eventId: placeholderEventId,
    totalSupply: supply,
    issuerPubkey: issuer,
    metadataRoot: root,
    encoding: "cbor-v1",
    treeScheme: "oz-simple-v1",
  };
  const signedManifest = signManifest(manifestBody, priv);
  console.log(`built manifest: supply=${supply} root=${root.slice(0, 14)}… issuer=${issuer.slice(0, 12)}…`);

  console.log("calling issuePodType (uploads + on-chain register + directory write)…");
  const entry = await issuePodType({
    creatorAddress: CREATOR,
    kind: "badge",
    name: "Smoke Test Badge",
    description: "issuance smoke test",
    supply,
    signedManifest,
    podBodies,
  });

  console.log("OK");
  console.log(`  manifestRef:     ${entry.manifestRef}`);
  console.log(`  onChain eventId: ${entry.eventId}`);
  console.log(`  swarmManifestRef:${entry.swarmManifestRef}`);
  console.log(`  explorer (event id is keccak(sponsor,nonce); tx in server logs above)`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
