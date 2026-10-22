/**
 * Everything that decides WHICH key a Web3Auth login returns - pinned, so no change
 * (ours or an SDK upgrade's) can silently move every email account to a new address.
 *
 * The key is the Web3Auth network's answer for (network, clientId, auth connection
 * ids, the person's login), handed back through the auth connector. On WoCo's side
 * that means:
 *  - our options: clientId, web3AuthNetwork, the OTHER-namespace chain, and NOTHING
 *    that selects another key (useSFAKey -> core-kit key, a privateKeyProvider,
 *    custom auth connections / modalConfig, account abstraction, ...): the options
 *    object is pinned WHOLE, so an added option fails here first;
 *  - the SDK's own key path, read from the installed v11 source: the final key is
 *    authInstance.privKey unless useSFAKey; Auth is built from clientId + network +
 *    the non-default connections; logins use the OTHER curve; the default email
 *    connection's ids come from the dashboard project config, combined as
 *    `${grouped}_${id}`; `private_key` returns the key setupProvider was given.
 * All of these were diffed against v10 (modal 10.15.0, no-modal 10.16.0, auth 10.8.0)
 * on 2026-10-10: identical, apart from v11's request-engine rename and audit-only
 * login fields (recordId, loginSource). The network's own derivation is server-side
 * and cannot be pinned here - the laptop sign-in in the PR's test list covers it.
 *
 * MUTATIONS (each went red, then restored): an option added (useSFAKey: true); the
 * network mapping swapped; the chain namespace changed; consent no longer pinned off;
 * a key option slipped into the look (WEB3AUTH_LOOK); a logo adding more than its two fields.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mod = await import("@web3auth/modal");
const { web3AuthOptionsFor, WEB3AUTH_SESSION_SECONDS, WEB3AUTH_LOOK } = await import("../src/lib/auth/web3auth-config.ts");
const { isWeb3AuthSessionLive } = await import("../src/lib/auth/web3auth-survivor.ts");

const CLIENT = "BPi5_pinned_client_id";

const expected = (web3AuthNetwork: string) => ({
  clientId: CLIENT,
  web3AuthNetwork,
  multiInjectedProviderDiscovery: false,
  disableAnalytics: true,
  chains: [
    {
      chainNamespace: "other",
      chainId: "0x1",
      rpcTarget: "https://rpc.ankr.com/eth",
      displayName: "WoCo recovery key",
      blockExplorerUrl: "https://etherscan.io",
      ticker: "ETH",
      tickerName: "Ethereum",
      logo: "https://web3auth.io/images/web3authlog.png",
    },
  ],
  defaultChainId: "0x1",
  sessionTime: WEB3AUTH_SESSION_SECONDS,
  initialAuthenticationMode: "connect-only",
  uiConfig: { ...WEB3AUTH_LOOK, consentRequired: false },
});

test("the options, whole: mainnet and devnet map to their exact network names, nothing else selects a key", () => {
  assert.deepEqual(web3AuthOptionsFor(mod, CLIENT, "sapphire_mainnet"), expected("sapphire_mainnet"));
  assert.deepEqual(web3AuthOptionsFor(mod, CLIENT, "sapphire_devnet"), expected("sapphire_devnet"));
  assert.equal(mod.WEB3AUTH_NETWORK.SAPPHIRE_MAINNET, "sapphire_mainnet");
  assert.equal(mod.WEB3AUTH_NETWORK.SAPPHIRE_DEVNET, "sapphire_devnet");
  assert.equal(mod.CHAIN_NAMESPACES.OTHER, "other");
});

test("iPhone/iPad redirect options: the SAME options, plus uxMode and nothing else - no key input moves (owner 2026-10-12)", () => {
  for (const network of ["sapphire_mainnet", "sapphire_devnet"] as const) {
    const popup = web3AuthOptionsFor(mod, CLIENT, network);
    const redirect = web3AuthOptionsFor(mod, CLIENT, network, "redirect");
    assert.deepEqual(redirect, { ...expected(network), uiConfig: { ...WEB3AUTH_LOOK, consentRequired: false, uxMode: "redirect" } });
    assert.deepEqual(web3AuthOptionsFor(mod, CLIENT, network, "popup"), popup, "the pop-up options stay byte-identical");
    const { uiConfig: _r, ...redirectKeyInputs } = redirect;
    const { uiConfig: _p, ...popupKeyInputs } = popup;
    assert.deepEqual(redirectKeyInputs, popupKeyInputs, "clientId, network, chain, session: all identical");
    assert.ok(!("useSFAKey" in redirect) && !("privateKeyProvider" in redirect) && !("modalConfig" in redirect));
  }
  assert.equal(mod.UX_MODE.REDIRECT, "redirect");
});

test("SDK: uxMode is transport - the Auth constructor's key inputs are the same object in both modes", () => {
  // The connector adds only replaceUrlOnRedirect + useCoreKitKey (= useSFAKey, never set) to its
  // auth options, then builds Auth from clientId + network + IFRAME + the non-default connections
  // whatever the mode; the default email login's ids come from the same Login.js branch.
  const c = flat(connector);
  assert.match(c, /this\.authOptions = _objectSpread\(_objectSpread\(\{\}, this\.authOptions\), \{\}, \{ replaceUrlOnRedirect: isRedirectResult, useCoreKitKey: this\.coreOptions\.useSFAKey \}\);/);
  // The redirect leaves from connectWithSocialLogin AFTER the same loginParams/ids are built.
  const social = c.slice(c.indexOf("async connectWithSocialLogin(params) {"), c.indexOf("async accessTokenProvider("));
  assert.ok(social.indexOf("authConnectionId: providerConfig.authConnectionId") < social.indexOf("verifierWindow.redirect("));
});

const src = (rel: string) => readFileSync(new URL(`../node_modules/${rel}`, import.meta.url), "utf8");
const connector = src("@web3auth/no-modal/dist/lib.esm/connectors/auth-connector/authConnector.js");
const flat = (s: string) => s.replace(/\s+/g, " ");

test("SDK: the final key is the auth session's privKey, the core-kit key only with useSFAKey (which we never set)", () => {
  const body = flat(connector.slice(connector.indexOf("_getFinalPrivKey() {"), connector.indexOf("async connectWithProvider(")));
  assert.match(body, /let finalPrivKey = this\.authInstance\.privKey;/);
  assert.match(body, /if \(this\.coreOptions\.useSFAKey\) \{/);
  assert.match(body, /finalPrivKey = this\.authInstance\.coreKitKey;/);
  assert.ok(!("useSFAKey" in web3AuthOptionsFor(mod, CLIENT, "sapphire_mainnet")));
});

test("SDK: Auth is built from our clientId and network and the non-default connections; logins use the OTHER curve", () => {
  const ctor = flat(connector.slice(connector.indexOf("this.authInstance = new Auth("), connector.indexOf("this.authInstance = new Auth(") + 400));
  assert.match(ctor, /clientId: this\.coreOptions\.clientId, network: this\.coreOptions\.web3AuthNetwork, sdkMode: SDK_MODE\.IFRAME, authConnectionConfig: this\.authConnectionConfig\.filter\(x => !x\.isDefault\)/);
  assert.match(connector, /this\.loginSettings\.curve = SUPPORTED_KEY_CURVES\.OTHER;/);
  // The OTHER namespace: the key goes to a CommonPrivateKeyProvider, never ws-embed.
  assert.match(flat(connector), /const \{ CommonPrivateKeyProvider \} = await import\('\.\.\/\.\.\/providers\/base-provider\/index\.js'\);/);
  assert.match(flat(connector), /const finalPrivKey = this\._getFinalPrivKey\(\); if \(finalPrivKey\) \{ await this\.privateKeyProvider\.setupProvider\(finalPrivKey, params\.chainId\);/);
});

test("SDK: private_key returns exactly the key setupProvider was given", () => {
  const p = flat(src("@web3auth/no-modal/dist/lib.esm/providers/base-provider/commonPrivateKeyProvider.js"));
  assert.match(p, /getPrivatekey: async \(\) => \{ if \(!this\.config\.keyExportEnabled\) throw new Error\([^)]*\); return privKey; \}/);
  assert.match(p, /async function getPrivatekeyHandler\(\) \{ return getPrivatekey\(\); \}/);
  assert.match(p, /private_key: getPrivatekeyHandler/);
});

test("SDK: the default email login sends the dashboard's connection ids, combined as grouped_id", () => {
  const login = flat(src("@web3auth/modal/dist/lib.esm/packages/modal/src/ui/containers/Login/Login.js"));
  assert.match(
    login,
    /const connectorConfig = socialLoginsConfig\.loginMethods\[AUTH_CONNECTION\.EMAIL_PASSWORDLESS\]; if \(connectorConfig\.isDefault\) \{ return handleSocialLoginClick\(\{ loginParams: \{ authConnection: AUTH_CONNECTION\.EMAIL_PASSWORDLESS, authConnectionId: connectorConfig\.authConnectionId, groupedAuthConnectionId: connectorConfig\.groupedAuthConnectionId,/,
  );
  const manager = flat(src("@web3auth/modal/dist/lib.esm/packages/modal/src/modalManager.js"));
  assert.match(manager, /getCombinedConnectionId\(authConnectionId, groupedAuthConnectionId\) \{ let id = authConnectionId; if \(groupedAuthConnectionId\) \{ id = `\$\{groupedAuthConnectionId\}_\$\{authConnectionId\}`;/);
});

test("consent_requiring: pinned off in our options, and never read as a live session if it ever appears", () => {
  assert.equal(web3AuthOptionsFor(mod, CLIENT, "sapphire_mainnet").uiConfig.consentRequired, false);
  // App options win over the dashboard's: both merges put ours last.
  const manager = flat(src("@web3auth/modal/dist/lib.esm/packages/modal/src/modalManager.js"));
  assert.match(manager, /this\.options\.uiConfig = deepmerge\(cloneDeep\(projectConfig\.whitelabel \|\| \{\}\), this\.options\.uiConfig \|\| \{\}\);/);
  assert.match(manager, /this\.options\.uiConfig = deepmerge\(projectConfig\.loginModal \|\| \{\}, this\.options\.uiConfig, \{/);
  // Defence in depth: a session waiting on consent is never adopted as signed in.
  const base = { connected: true, cachedConnector: "auth" };
  assert.equal(isWeb3AuthSessionLive({ ...base, status: "consent_requiring" } as never), false);
  assert.equal(isWeb3AuthSessionLive({ ...base, status: "connected" } as never), true);
});

test("the look is display only: pinned literally, a logo adds only the two logo fields (owner 2026-10-22)", () => {
  // Literal, not WEB3AUTH_LOOK: the whole-object pin above spreads the look, so a
  // key-selecting option slipped into it must fail here.
  assert.deepEqual(WEB3AUTH_LOOK, {
    appName: "WoCo",
    mode: "dark",
    theme: { primary: "#C7F23A", onPrimary: "#0B0B09" },
    borderRadiusType: "small",
    buttonRadiusType: "square",
    loginMethodsOrder: ["google", "apple", "facebook", "twitter"],
  });
  const logo = "https://assets.example/icons/icon-192.png";
  for (const uxMode of ["popup", "redirect"] as const) {
    const plain = web3AuthOptionsFor(mod, CLIENT, "sapphire_mainnet", uxMode);
    const branded = web3AuthOptionsFor(mod, CLIENT, "sapphire_mainnet", uxMode, logo);
    assert.deepEqual(branded, { ...plain, uiConfig: { ...plain.uiConfig, logoLight: logo, logoDark: logo } });
  }
  // The auth connector hands uiConfig over as whiteLabel - the look of Web3Auth's
  // own sign-in pages, serialised into the pop-up's state beside the login params.
  const c = flat(connector);
  assert.match(c, /const uiConfig = coreOptions\.uiConfig \|\| \{\}; connectorSettings\.whiteLabel = uiConfig;/);
  assert.match(c, /whiteLabel: JSON\.stringify\(this\.authInstance\.options\.whiteLabel\), loginParams: JSON\.stringify\(loginParams\),/);
});
