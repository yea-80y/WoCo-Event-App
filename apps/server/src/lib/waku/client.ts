/**
 * Waku light node singleton for server-side event announcement publishing.
 *
 * Lazy-initialised on first use. Gated by WAKU_ENABLED env var.
 * If Waku is unavailable, all operations degrade gracefully (log + return null).
 */
import type { LightNode } from "@waku/sdk";


let _node: LightNode | null = null;
let _initialising: Promise<LightNode | null> | null = null;

export function isWakuEnabled(): boolean {
  return process.env.WAKU_ENABLED === "true";
}

/**
 * Get the Waku light node, creating it on first call.
 * Returns null if Waku is disabled or initialisation fails.
 */
export async function getWakuNode(): Promise<LightNode | null> {
  if (!isWakuEnabled()) return null;
  if (_node) return _node;
  if (_initialising) return _initialising;

  _initialising = initNode();
  const node = await _initialising;
  _initialising = null;
  return node;
}

function getBootstrapPeers(): string[] | undefined {
  const raw = process.env.WAKU_BOOTSTRAP_PEERS;
  if (!raw) return undefined;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

async function initNode(): Promise<LightNode | null> {
  try {
    const peers = getBootstrapPeers();
    console.log(
      peers
        ? `[waku] Initialising light node with bootstrap peers: ${peers.join(", ")}`
        : "[waku] Initialising light node with default bootstrap...",
    );
    const { createLightNode, Protocols } = await import("@waku/sdk");

    const node = await createLightNode(
      peers
        ? {
            bootstrapPeers: peers,
            networkConfig: { clusterId: 42, numShardsInCluster: 1 },
          }
        : { defaultBootstrap: true },
    );

    await node.start();
    console.log("[waku] Node started, waiting for peers...");

    // Wait for LightPush peer (needed for publishing)
    await node.waitForPeers([Protocols.LightPush], 15_000);
    console.log("[waku] Connected to LightPush peer");

    _node = node;
    return node;
  } catch (err) {
    console.error("[waku] Failed to initialise:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Gracefully stop the Waku node (call on server shutdown).
 */
export async function stopWakuNode(): Promise<void> {
  if (_node) {
    try {
      await _node.stop();
      console.log("[waku] Node stopped");
    } catch {
      // ignore shutdown errors
    }
    _node = null;
  }
}
