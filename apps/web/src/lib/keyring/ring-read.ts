/**
 * Read an account's key ring by the reference its anchor names (#186): every chunk is
 * fetched from the gateway and checked against the address its parent names, so the
 * bytes are exactly the ring the chain points at, whoever served them.
 *
 * Lazy: loads the ring parser (the lattice code comes with it).
 */
import { WOCO_GATEWAY_URL } from "../swarm/gateways.js";

export async function fetchKeyRing(ref: string) {
  const [{ readBytesTree }, { parseKeyRing, MAX_KEY_RING_BYTES }] = await Promise.all([
    import("@woco/shared/swarm/bytes-tree"),
    import("@woco/shared/keyring/ring"),
  ]);
  const bytes = await readBytesTree(
    ref,
    async (address) => {
      const res = await fetch(`${WOCO_GATEWAY_URL}/chunks/${address}`);
      if (!res.ok) throw new Error(`gateway HTTP ${res.status} for ring chunk ${address}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    MAX_KEY_RING_BYTES,
  );
  return parseKeyRing(bytes);
}
