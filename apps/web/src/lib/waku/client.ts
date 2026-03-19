/**
 * Waku light node singleton for browser-side event discovery.
 *
 * Lazy-initialised on first use. Uses dynamic import to avoid loading
 * the Waku SDK (~500KB) until needed — keeps initial page load fast.
 *
 * If Waku is unavailable, all operations degrade gracefully.
 */
import type { LightNode } from "@waku/sdk";
import { WAKU_CLUSTER_ID } from "@woco/shared";

let _node: LightNode | null = null;
let _initialising: Promise<LightNode | null> | null = null;

/**
 * Get the Waku light node, creating it on first call.
 * Returns null if initialisation fails (network issues, etc.).
 */
export async function getWakuNode(): Promise<LightNode | null> {
  if (_node) return _node;
  if (_initialising) return _initialising;

  _initialising = initNode();
  const node = await _initialising;
  _initialising = null;
  return node;
}

async function initNode(): Promise<LightNode | null> {
  try {
    console.log("[waku] Initialising browser light node...");
    const { createLightNode, Protocols } = await import("@waku/sdk");

    const node = await createLightNode({
      defaultBootstrap: true,
      networkConfig: {
        clusterId: WAKU_CLUSTER_ID,
      },
    });

    await node.start();
    console.log("[waku] Node started, waiting for peers...");

    // Wait for Filter + Store peers (needed for subscribing and querying history)
    await node.waitForPeers(
      [Protocols.Filter, Protocols.Store],
      20_000,
    );
    console.log("[waku] Connected to Filter + Store peers");

    _node = node;
    return node;
  } catch (err) {
    console.warn(
      "[waku] Failed to initialise (discovery will use Swarm directory only):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Stop the Waku node. Call on app unmount if needed.
 */
export async function stopWakuNode(): Promise<void> {
  if (_node) {
    try { await _node.stop(); } catch { /* ignore */ }
    _node = null;
  }
}
