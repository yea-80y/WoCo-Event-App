/**
 * The organiser key's proof for a ledger2 registration (`@woco/shared/crypto/organiser-key`).
 *
 * Derived here, from the account's CURRENT secret (#186), signs the binding, and is
 * zeroed before this returns: the key never leaves this function and is never stored.
 * Only its address and the binding go to the server, which names that key on chain for
 * the event, so the organiser - not the platform - holds the event's terms from then on.
 *
 * FAIL LOUD, NEVER ANOTHER SIGNER: with no current secret this throws. A feed signer or
 * session key would sign a binding just as well and leave the event's terms with a key
 * nobody derives again.
 */

import type { OrganiserKeyBindingV1 } from "@woco/shared";
import { auth } from "./auth-store.svelte.js";

export async function organiserKeyBinding(): Promise<OrganiserKeyBindingV1> {
  await auth.ensureOrganiserUnlock();
  const parent = auth.parent?.toLowerCase();
  const secrets = await auth.getAccountSecrets({ toSeal: true });
  if (!parent || !secrets) {
    throw new Error("Your account's signing key isn't available on this device - sign in again and retry.");
  }
  const { deriveOrganiserKey, signOrganiserKeyBinding } = await import("@woco/shared/crypto/organiser-key");
  const key = deriveOrganiserKey(secrets.current);
  try {
    return signOrganiserKeyBinding(key, parent, secrets.gen);
  } finally {
    key.privateKey.fill(0);
  }
}
