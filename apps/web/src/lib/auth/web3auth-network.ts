/**
 * The Web3Auth network name, validated, in ONE place.
 *
 * Imported by the runtime (`web3auth-config.ts`) AND by the production build gate
 * (`apps/web/vite.config.ts`), so the two cannot drift: whatever the build refuses
 * to ship, the browser also refuses to initialise, and vice versa.
 *
 * Deliberately plain: no Svelte, no browser globals, no `import.meta.env`, no
 * `@web3auth/modal`. Vite loads this module in Node at CONFIG time, and the SDK
 * must stay behind a dynamic import so it never enters the eager bundle.
 */

/** Named once so the runtime error, the build error and the docs cannot disagree. */
export const WEB3AUTH_NETWORK_ENV_VAR = "VITE_WEB3AUTH_NETWORK";

export type Web3AuthNetworkName = "sapphire_mainnet" | "sapphire_devnet";

export const WEB3AUTH_NETWORK_VALUES: readonly Web3AuthNetworkName[] = ["sapphire_mainnet", "sapphire_devnet"];

/**
 * 🔴 FUNDS-CRITICAL, FAILS CLOSED (#244). The network is an input to every
 * Web3Auth user's key derivation, alongside the clientId — so an unrecognised
 * value must REFUSE, never pick one.
 *
 * What this replaces: `?? "sapphire_devnet"`. An UNSET variable silently selected
 * the development network — and so did a value that merely LOOKS configured
 * ("sapphire-mainnet", "mainnet", a stray leading space). Either way every account
 * derives a different key and every escrow envelope sealed to the old one is
 * orphaned, with nothing on screen to say so.
 *
 * No trim and no case-fold on purpose: " sapphire_mainnet" is a misconfiguration
 * of a funds-critical input, and quietly repairing one is how the next one goes
 * unnoticed. The only two acceptable inputs are the two exact strings.
 */
export function resolveWeb3AuthNetwork(raw: string | undefined): Web3AuthNetworkName {
  if (raw === "sapphire_mainnet" || raw === "sapphire_devnet") return raw;
  const offending = raw === undefined ? "unset" : `"${raw}"`;
  throw new Error(
    `${WEB3AUTH_NETWORK_ENV_VAR} must be exactly one of ${WEB3AUTH_NETWORK_VALUES.join(" | ")} — got ${offending}. ` +
      `It selects the key-derivation network for every Web3Auth account, so an unrecognised value is refused, never defaulted.`,
  );
}
