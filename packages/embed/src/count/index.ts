/**
 * Entry for `woco-count.js` — the lap-count bundle.
 *
 * SEPARATE FROM `woco-embed.js` ON PURPOSE. That bundle carries wallet
 * connection, WebAuthn and the whole claim/checkout path, and measures ~113KB.
 * A counter executes none of it. The two surfaces this serves are an OBS scene
 * on a venue's connection and a partner's own marketing page during the
 * busiest traffic this rail will ever see, so handing either of them a payment
 * widget to render a number would be a cost with nothing on the other side.
 *
 * MEASURED, so the next person does not re-litigate it: `woco-embed.js` is
 * 113KB (37KB gzipped) and this bundle is 40KB (14KB gzipped). Nearly all of
 * what remains is `@noble/curves` and `@noble/hashes`, reached because the
 * shared subject registry keys its catalogue by a keccak hash computed at
 * module load. Importing the registry deeply rather than through the package
 * barrel cuts reachable modules from 301 to 53 without changing the byte count,
 * which is why it is written that way in `woco-lap-count.ts`.
 *
 * Replacing the registry with a precomputed name table here would cut the
 * bundle to roughly 4KB, and it was rejected: the saving is invisible on pages
 * that already load megabytes, and a copied table either drifts from the
 * registry or has to be regenerated every time a coaster is added — a standing
 * cost paid on every future branch to buy 10KB nobody will feel.
 */

import { WocoLapCount } from "./woco-lap-count.js";

if (!customElements.get("woco-lap-count")) {
  customElements.define("woco-lap-count", WocoLapCount);
}

export { WocoLapCount };
