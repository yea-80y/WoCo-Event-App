export { createWeb3Signer } from "./web3-signer.js";
export { createLocalSigner } from "./local-signer.js";
export { createPasskeySigner } from "./passkey-signer.js";
// createParaSigner intentionally NOT re-exported — import it dynamically from
// "./para-signer.js" so the Para SDK (~640KB) does not get pulled into chunks
// that touch other signers. See auth-store.svelte.ts for the lazy load pattern.
