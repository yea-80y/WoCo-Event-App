/**
 * What the CCIP gateway will serve for a name whose holder pointer is
 * `pointerSwarmHash`, computed by the gateway's own WoCo-built rule with the real
 * inputs. The cert warm-up waits for THIS - the raw pointer is never served any
 * more, so waiting for it would never knock and a new name would get no
 * certificate (cert-warmup.ts, #557).
 */
import { hexlify } from "ethers";
import { contenthashPolicy } from "./ccip.js";
import { getApexContenthash } from "../chain/sub-ens-apex.js";
import { lookupNameTarget } from "../sub-ens/name-targets.js";
import { decodeSwarmContenthash, encodeSwarmContenthash } from "../sub-ens/swarm-contenthash.js";

export function servedContenthashFor(pointerSwarmHash: string): { contenthash: string; swarmHash: string } | null {
  const { contenthash } = contenthashPolicy({
    depth: 1,
    l2Contenthash: hexlify(encodeSwarmContenthash(pointerSwarmHash)),
    apexHash: getApexContenthash(),
    lookupBuilt: lookupNameTarget,
  });
  const swarmHash = decodeSwarmContenthash(contenthash);
  return swarmHash ? { contenthash, swarmHash } : null;
}
