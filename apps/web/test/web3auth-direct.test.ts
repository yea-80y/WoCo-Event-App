/**
 * WoCo's own email / Google / Apple buttons (owner 2026-10-22) send exactly what
 * Web3Auth's modal buttons send, so an account signs in to the same address
 * whichever screen it used. Read from the installed v11 source:
 *  - the modal builds each default login method from the dashboard's connection
 *    (modalManager `filterConnectors`) and hands that object to its buttons;
 *  - its email button (Login.js `handleFormSubmit`) and social rows send fixed
 *    fields copied from it to `connectTo("auth", params, MODAL)`;
 *  - `directLoginParams` copies the same fields from the same object;
 *  - the loginMode we leave out never reaches the connector.
 * The network's own derivation stays server-side: the same-address sign-in in the
 * PR's test list covers it, as for #956.
 *
 * MUTATIONS (each went red, then restored): an id dropped from our email params;
 * extraLoginOptions dropped from the social params; a non-default method accepted;
 * the email check loosened.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { directLoginParams, EMAIL_PATTERN } = await import("../src/lib/auth/web3auth-direct.ts");

const src = (rel: string) => readFileSync(new URL(`../node_modules/${rel}`, import.meta.url), "utf8").replace(/\s+/g, " ");
const ui = "@web3auth/modal/dist/lib.esm/packages/modal/src";
const login = src(`${ui}/ui/containers/Login/Login.js`);
const manager = src(`${ui}/modalManager.js`);
const noModal = src("@web3auth/no-modal/dist/lib.esm/noModal.js");
const adapter = readFileSync(new URL("../src/lib/auth/web3auth-sdk-adapter.ts", import.meta.url), "utf8").replace(/\s+/g, " ");

/** A dashboard default, as `filterConnectors` stores it. */
const method = (authConnection: string, name: string) => ({
  name,
  authConnection,
  authConnectionId: `w3a-${authConnection}`,
  groupedAuthConnectionId: undefined,
  extraLoginOptions: { prompt: "login" },
  isDefault: true,
  showOnModal: true,
});
const METHODS = {
  email_passwordless: method("email_passwordless", "Email Passwordless"),
  google: method("google", "Google"),
  apple: method("apple", "Apple"),
};

test("SDK: a default login method is the dashboard's connection, as the modal's buttons receive it", () => {
  assert.match(
    manager,
    /if \(isDefault\) \{ loginMethods\[authConnection\] = \{ name: AUTH_PROVIDERS_NAMES\[authConnection\], authConnection: authConnection, authConnectionId: authConnectionId, groupedAuthConnectionId: groupedAuthConnectionId, extraLoginOptions: authConnectionConfig\.jwtParameters, isDefault: true, showOnModal: true \};/,
  );
  // The buttons' config is this map: the adapter reads the same one.
  assert.match(manager, /const loginMethods = \(\(_this\$modalConfig\$con6 = this\.modalConfig\.connectors\[connectorName\]\) === null \|\| _this\$modalConfig\$con6 === void 0 \? void 0 : _this\$modalConfig\$con6\.loginMethods\) \|\| \{\}; this\.loginModal\.addSocialLogins\(loginMethods,/);
  assert.ok(adapter.includes(".modalConfig?.connectors?.[AUTH_CONNECTOR]?.loginMethods ?? null"));
});

test("email: the modal's button and ours send the same fields from the same method", () => {
  assert.match(
    login,
    /if \(connectorConfig\.isDefault\) \{ return handleSocialLoginClick\(\{ loginParams: \{ authConnection: AUTH_CONNECTION\.EMAIL_PASSWORDLESS, authConnectionId: connectorConfig\.authConnectionId, groupedAuthConnectionId: connectorConfig\.groupedAuthConnectionId, extraLoginOptions: connectorConfig\.extraLoginOptions, loginHint: loginHint, name: "Email" \} \}\);/,
  );
  const m = METHODS.email_passwordless;
  assert.deepEqual(directLoginParams(METHODS, { kind: "email", email: "name@example.com" }), {
    authConnection: "email_passwordless",
    authConnectionId: m.authConnectionId,
    groupedAuthConnectionId: m.groupedAuthConnectionId,
    extraLoginOptions: m.extraLoginOptions,
    loginHint: "name@example.com",
    name: "Email",
  });
});

test("Google and Apple: the modal's row and ours send the same fields from the same method", () => {
  assert.match(login, /const name = capitalizeFirstLetter\(connectorConfig\.name \|\| method\);/);
  assert.match(
    login,
    /loginParams: \{ authConnection: connectorConfig\.authConnection \|\| method, authConnectionId: connectorConfig\.authConnectionId, groupedAuthConnectionId: connectorConfig\.groupedAuthConnectionId, extraLoginOptions: connectorConfig\.extraLoginOptions, name, login_hint: "" \},/,
  );
  for (const connection of ["google", "apple"] as const) {
    const m = METHODS[connection];
    assert.deepEqual(directLoginParams(METHODS, { kind: "social", connection }), {
      authConnection: connection,
      authConnectionId: m.authConnectionId,
      groupedAuthConnectionId: m.groupedAuthConnectionId,
      extraLoginOptions: m.extraLoginOptions,
      name: m.name,
      login_hint: "",
    });
  }
});

test("only a dashboard default goes direct: anything else, or nothing, is left to the modal", () => {
  const custom = { ...METHODS, email_passwordless: { ...METHODS.email_passwordless, isDefault: false } };
  assert.equal(directLoginParams(custom, { kind: "email", email: "name@example.com" }), null);
  assert.equal(directLoginParams({}, { kind: "social", connection: "apple" }), null);
  assert.equal(directLoginParams(null, { kind: "social", connection: "google" }), null);
  // The modal's own non-default email path is a different flow, which is why.
  assert.match(login, /\} else \{ return handleCustomLogin\(AUTH_CONNECTION\.EMAIL_PASSWORDLESS, loginHint\); \}/);
});

test("the modal's click and ours reach the connector alike: loginMode is the SDK's own label, never a login param", () => {
  assert.match(manager, /await this\.connectTo\(WALLET_CONNECTORS\.AUTH, params\.loginParams, LOGIN_MODE\.MODAL\);/);
  assert.match(noModal, /async connectTo\(connectorName, loginParams, loginMode\) \{ this\.loginMode = loginMode \|\| "no-modal";/);
  assert.match(
    noModal,
    /const finalLoginParams = _objectSpread\(_objectSpread\(\{\}, loginParams\), \{\}, \{ chainId: initialChain\.chainId, getAuthTokenInfo: this\.coreOptions\.initialAuthenticationMode === CONNECTOR_INITIAL_AUTHENTICATION_MODE\.CONNECT_AND_SIGN \}\);/,
  );
  assert.match(noModal, /connector\.connect\(finalLoginParams\);/);
  // Ours goes through the adapter's normalising wrapper, with no loginMode.
  assert.ok(adapter.includes("connectTo: async (connectorName, loginParams) => ((await sdk.connectTo?.(connectorName, loginParams)) ? keyProvider() : null),"));
});

test("the email check is the modal's own, so we never send an address it would refuse", () => {
  assert.ok(login.includes("const isEmailValid = loginHint.match(/^([\\w.%+-]+)@([\\w-]+\\.)+([\\w]{2,})$/i);"));
  assert.equal(EMAIL_PATTERN.source, String.raw`^([\w.%+-]+)@([\w-]+\.)+([\w]{2,})$`);
  assert.equal(EMAIL_PATTERN.flags, "i");
  for (const ok of ["name@example.com", "first.last+tag@sub.example.co.uk"]) assert.ok(EMAIL_PATTERN.test(ok), ok);
  for (const bad of ["name", "name@", "name@example", "@example.com", "name example@x.com"]) assert.ok(!EMAIL_PATTERN.test(bad), bad);
});

test("SDK: why a direct start must reset the modal's screen - CONNECTING sets its loader for any start, a failure clears it only for the modal's own", () => {
  const modal = src(`${ui}/ui/loginModal.js`);
  assert.match(modal, /listener\.on\(CONNECTOR_EVENTS\.CONNECTING, data => \{/);
  assert.match(modal, /this\.setState\(\{ status: MODAL_STATUS\.CONNECTING \}\);/);
  assert.match(modal, /listener\.on\(CONNECTOR_EVENTS\.ERRORED, \(error, loginMode\) => \{ log\.error\("error", error, error\.message\); if \(loginMode === LOGIN_MODE\.NO_MODAL\) return;/);
  // What we call, and the state it means: the sign-in options.
  assert.match(modal, /_defineProperty\(this, "setState", newState => \{ if \(newState\.status\) this\.modalStatus = newState\.status;/);
  assert.match(src(`${ui}/ui/interfaces.js`), /INITIALIZED: "initialized",/);
  assert.match(modal, /_defineProperty\(this, "open", \(\) => \{ var _this\$analytics, _this\$uiConfig\$wallet, _this\$uiConfig\$wallet2; this\.setState\(\{ modalVisibility: true \}\);/, "opening it does not reset the screen");
});

test("SDK: a blocked sign-in pop-up is customauth's plain Error, not a coded LoginError (Fable, #959)", () => {
  // The connector's PopupHandler comes from @web3auth/auth, which re-exports customauth wholesale.
  assert.match(src("@web3auth/no-modal/dist/lib.esm/connectors/auth-connector/authConnector.js"), /import \{[^}]*\bPopupHandler\b[^}]*\} from '@web3auth\/auth';/);
  assert.match(src("@web3auth/auth/dist/lib.esm/index.js"), /^export \* from '@toruslabs\/customauth';/);
  assert.match(src("@toruslabs/customauth/dist/lib.esm/index.js"), /export \{ PopupHandler \} from '\.\/utils\/PopupHandler\.js';/);
  assert.match(src("@toruslabs/customauth/dist/lib.esm/utils/PopupHandler.js"), /if \(!this\.window\) throw new Error\("popup window is blocked"\);/);
});
