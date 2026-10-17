/**
 * The organiser's X-Wing keys for their contact list (#642), from the account's
 * secrets, plus the seal context that binds the list to this account. Shared by
 * the Audience screen and the automatic buyer add, so both seal the same way.
 * The post-quantum code is loaded here, on first use, never with the page.
 */
export async function listKeysOf(secrets: { current: string; all: string[] }, parent: string) {
  const [{ orderKeysOf }, box] = await Promise.all([
    import("../../keyring/order-keys.js"),
    import("@woco/shared/crypto/sealed-box"),
  ]);
  // New lists seal to the CURRENT generation; an older one opens with its own (#186).
  const { publicKey, secretKeys } = await orderKeysOf(secrets);
  return { secretKeys, publicKey, ctx: box.listSealContext(parent), box };
}
