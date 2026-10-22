/**
 * Shared Web3Auth (v10 PnP Modal) config + raw-key extraction, used by BOTH the
 * primary email login (`web3auth-account.ts`) and the email backup factor
 * (`wallet/backup-signer.ts`). Centralised because these bits are funds-critical
 * and MUST NOT drift between the two call sites — when they did, a fix to one left
 * the other broken.
 *
 * Why chainNamespace OTHER: in v10 an EIP155/SOLANA chain routes the provider
 * through ws-embed (a remote-signing embedded wallet) which never exposes the raw
 * key — `eth_private_key`/`private_key` 404 on its Torus controller. A chain with
 * namespace OTHER instead binds the provider to CommonPrivateKeyProvider, which
 * serves `private_key`. The derived secp256k1 key is the same app-scoped key
 * either way; only the exposure path changes.
 */

import { resolveWeb3AuthNetwork, type Web3AuthNetworkName } from "./web3auth-network.js";
import { buildEnv } from "../build-env.js";
import type { Web3AuthUxMode } from "./web3auth-redirect.js";

type Web3AuthModule = typeof import("@web3auth/modal");

/**
 * How long a Web3Auth sign-in lasts: 30 days, the SDK's maximum, matching the
 * WoCo session it unlocks. Unset, the project dashboard's value applies - 1 day
 * for ours (read from the project config 2026-10-07) - and the first reload
 * after it ran out signed the person out of a WoCo session still valid for weeks
 * (#803). Not a key input: only clientId and network change keys.
 */
export const WEB3AUTH_SESSION_SECONDS = 30 * 86400;

/**
 * How the sign-in looks: WoCo's colours, name and mark, so it reads as WoCo's own
 * step rather than a white box from somewhere else over a dark app (owner
 * 2026-10-22). Web3Auth's "Powered by MetaMask" footer stays as their mark.
 * Display only - web3auth-key-inputs.test.ts pins that nothing here can select a
 * key. The SDK passes the same object to its sign-in pop-up as `whiteLabel`, so
 * the email-code window should follow it too. The in-page modal's greys and font
 * have no option; app.css maps them onto our tokens.
 */
export const WEB3AUTH_LOOK = {
  appName: "WoCo",
  // WoCo has no light theme.
  mode: "dark" as const,
  // --accent / --accent-ink. The SDK derives its shades from a hex, so no var() here.
  theme: { primary: "#C7F23A", onPrimary: "#0B0B09" },
  borderRadiusType: "small" as const,
  buttonRadiusType: "square" as const,
  // The order the sign-in button's marks promise. The SDK appends every other
  // enabled method after these, so none is hidden.
  loginMethodsOrder: ["google", "apple", "facebook", "twitter"],
};

/**
 * Constructor options for a Web3Auth instance that yields the raw recovery key.
 * 🔴 FUNDS-CRITICAL: the key is a deterministic function of (user login) ×
 * VITE_WEB3AUTH_CLIENT_ID × network. Changing clientId or network changes every
 * user's key and orphans every escrow envelope sealed to the old key. Pin both
 * for production; never repoint a live deployment.
 */
export function buildWeb3AuthOptions(mod: Web3AuthModule, clientId: string, uxMode: Web3AuthUxMode = "popup") {
  // THROWS on anything that is not one of the two exact names — there is no
  // default, because the wrong network is a wrong key, not a wrong feature flag
  // (#244). Under plain Node (the unit test) the setting reads as absent and the
  // validator refuses `undefined` — the same verdict, reached the same way.
  const networkEnv = buildEnv(() => import.meta.env.VITE_WEB3AUTH_NETWORK as string | undefined);
  // The app icon from wherever this build's assets are served (its <base href>):
  // the modal shows it, and Web3Auth's pop-up loads it from the same address.
  const logo = typeof document === "undefined" ? undefined : new URL("icons/icon-192.png", document.baseURI).href;
  return web3AuthOptionsFor(mod, clientId, resolveWeb3AuthNetwork(networkEnv), uxMode, logo);
}

/**
 * The options themselves, for a network already validated - split out so a test
 * can pin the WHOLE object (web3auth-key-inputs.test.ts): every option that can
 * decide which key a login returns is listed there, and an added option fails it.
 */
export function web3AuthOptionsFor(
  mod: Web3AuthModule,
  clientId: string,
  network: Web3AuthNetworkName,
  uxMode: Web3AuthUxMode = "popup",
  logo?: string,
) {
  const { WEB3AUTH_NETWORK, CHAIN_NAMESPACES, CONNECTOR_INITIAL_AUTHENTICATION_MODE } = mod;
  const web3AuthNetwork =
    network === "sapphire_mainnet" ? WEB3AUTH_NETWORK.SAPPHIRE_MAINNET : WEB3AUTH_NETWORK.SAPPHIRE_DEVNET;

  // OTHER namespace = key-only, no chain calls. But modal init still validates the
  // provider config and rejects an empty rpcTarget ("Please provide rpcTarget inside
  // chain"), so we give it a real URL. It is never actually called — `private_key`
  // extraction does no RPC — it only has to be a valid endpoint string.
  const chain = {
    chainNamespace: CHAIN_NAMESPACES.OTHER,
    chainId: "0x1",
    rpcTarget: "https://rpc.ankr.com/eth",
    displayName: "WoCo recovery key",
    blockExplorerUrl: "https://etherscan.io",
    ticker: "ETH",
    tickerName: "Ethereum",
    logo: "https://web3auth.io/images/web3authlog.png",
  };
  const look = logo ? { ...WEB3AUTH_LOOK, logoLight: logo, logoDark: logo } : WEB3AUTH_LOOK;

  return {
    clientId,
    web3AuthNetwork,
    // Only the email/social key — never browser extensions (an injected provider
    // hooking the wallet-services embed crashes the popup handshake).
    multiInjectedProviderDiscovery: false,
    // Keeps Segment's CDN loader out of the page entirely, which is what lets the
    // CSP (vite-plugins/csp.ts) omit cdn.segment.com from script-src.
    disableAnalytics: true,
    chains: [chain],
    defaultChainId: chain.chainId,
    sessionTime: WEB3AUTH_SESSION_SECONDS,
    // v11 defaults to CONNECT_AND_SIGN, where connect() settles only on AUTHORIZED -
    // and under CHAIN_NAMESPACES.OTHER nothing ever emits it (the auth connector
    // fetches the auth token, the only AUTHORIZED source, for EIP155/Solana only).
    // CONNECT_ONLY settles on CONNECTED, as v10 did.
    initialAuthenticationMode: CONNECTOR_INITIAL_AUTHENTICATION_MODE.CONNECT_ONLY,
    // v11 can hold a signed-in session in "consent_requiring" until the person
    // accepts Web3Auth's terms screen - switched on from the Web3Auth DASHBOARD
    // (uiConfig.consentRequired + links), not from code. WoCo's live-session test
    // (web3auth-survivor.ts) knows only connected/authorized, and WoCo shows its own
    // terms. App options are merged OVER the dashboard's (modalManager initUIConfig),
    // so this pins it off whatever the dashboard says.
    //
    // uxMode: how the sign-in page is reached - transport only, never a key input
    // (web3auth-redirect.ts). "redirect" on an iPhone/iPad sign-in (owner decision
    // 2026-10-12); left out otherwise, so the pop-up options stay byte-identical.
    // The look goes first, so nothing in it can switch consent back on.
    uiConfig:
      uxMode === "redirect"
        ? { ...look, consentRequired: false, uxMode: mod.UX_MODE.REDIRECT }
        : { ...look, consentRequired: false },
  };
}

type MinimalProvider = { request: (args: { method: string }) => Promise<unknown> };

/** Read the raw secp256k1 key (no 0x guaranteed) from a CommonPrivateKeyProvider. */
export async function extractRawPrivateKey(provider: MinimalProvider): Promise<string> {
  const raw = (await provider.request({ method: "private_key" })) as string | undefined;
  if (!raw) throw new Error("Couldn't read the Web3Auth wallet key — try again.");
  return raw;
}
