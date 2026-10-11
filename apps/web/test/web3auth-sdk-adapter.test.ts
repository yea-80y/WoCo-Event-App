/**
 * `@web3auth/modal` v11 presented in the shape WoCo's sign-in rules were built on
 * (web3auth-sdk-adapter.ts). v11 has no `web3auth.provider` and its `connect()`
 * resolves with a connection; the key still comes from the auth connector's own
 * provider (`CommonPrivateKeyProvider`, `private_key`, under CHAIN_NAMESPACES.OTHER).
 *
 * v11 also defaults to CONNECT_AND_SIGN, where connect() waits for AUTHORIZED - which
 * the OTHER namespace never emits - so the options pin CONNECT_ONLY.
 *
 * MUTATIONS (each went red, then restored): the CONNECT_ONLY option removed (the
 * options test); `provider` read from the connection
 * instead of the auth connector (the provider test); `connect()` returning the
 * connection itself (the connect test); a non-provider passed through (the guard
 * test); a build site constructing the SDK without the adapter (the wiring test).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { adaptWeb3AuthSdk, AUTH_CONNECTOR, type Web3AuthV11Like } from "../src/lib/auth/web3auth-sdk-adapter.ts";

const KEY = "11".repeat(32);
const keyProvider = { request: async ({ method }: { method: string }) => (method === "private_key" ? KEY : null) };

/** A v11 instance: connections, no `provider`, connect() resolves with a connection. */
class FakeV11 extends EventEmitter implements Web3AuthV11Like {
  connected = false;
  status = "not_ready";
  cachedConnector: string | null = null;
  connectorProvider: unknown = keyProvider;
  connectResult: unknown = { ethereumProvider: { request: async () => "a signing proxy, not the key" }, connectorName: "auth" };
  logouts: unknown[] = [];
  loginModal = { closeModal: () => void (this.closed += 1) };
  closed = 0;
  async init() {
    this.status = "ready";
  }
  async connect() {
    this.connected = true;
    this.status = "connected";
    return this.connectResult;
  }
  async logout(o?: { cleanup?: boolean }) {
    this.logouts.push(o);
  }
  getConnector(name: string) {
    return name === AUTH_CONNECTOR ? { provider: this.connectorProvider } : null;
  }
  async getUserInfo() {
    return { typeOfLogin: "email_passwordless" };
  }
}

test("provider is the auth connector's key provider - never the connection's signing proxy", async () => {
  const sdk = new FakeV11();
  const w = adaptWeb3AuthSdk(sdk);
  await w.init();
  assert.equal(w.provider, keyProvider, "present from init, as v10's was");
  assert.equal(await w.provider?.request({ method: "private_key" }), KEY);
});

test("connect() resolves with the key provider, or null when nothing connected", async () => {
  const sdk = new FakeV11();
  const w = adaptWeb3AuthSdk(sdk);
  assert.equal(await w.connect(), keyProvider);
  sdk.connectResult = null;
  assert.equal(await w.connect(), null);
});

test("a connector provider that cannot serve requests is never handed on", async () => {
  const sdk = new FakeV11();
  sdk.connectorProvider = { notAProvider: true };
  const w = adaptWeb3AuthSdk(sdk);
  assert.equal(w.provider, null);
  assert.equal(await w.connect(), null);
});

test("everything else passes straight through, live", async () => {
  const sdk = new FakeV11();
  const w = adaptWeb3AuthSdk(sdk);
  assert.equal(w.status, "not_ready");
  sdk.status = "connected";
  sdk.connected = true;
  sdk.cachedConnector = "auth";
  assert.equal(w.status, "connected");
  assert.equal(w.connected, true);
  assert.equal(w.cachedConnector, "auth");
  await w.logout({ cleanup: true });
  assert.deepEqual(sdk.logouts, [{ cleanup: true }]);
  assert.deepEqual(await w.getUserInfo(), { typeOfLogin: "email_passwordless" });
  w.loginModal?.closeModal?.();
  assert.equal(sdk.closed, 1);
  let heard: unknown = null;
  const fn = (d: unknown) => (heard = d);
  w.on("connected", fn);
  sdk.emit("connected", { reconnected: false });
  assert.deepEqual(heard, { reconnected: false }, "the sign-in wait's freshness flag still arrives");
  w.removeListener("connected", fn);
  heard = null;
  sdk.emit("connected", { reconnected: true });
  assert.equal(heard, null);
});

test("the installed SDK is v11 and has the shape the adapter reads", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../node_modules/@web3auth/modal/package.json", import.meta.url), "utf8"));
  assert.match(pkg.version, /^11\./);
  const { Web3Auth, CHAIN_NAMESPACES, CONNECTOR_EVENTS } = await import("@web3auth/modal");
  for (const m of ["init", "connect", "logout", "getConnector", "getUserInfo", "on", "removeListener"]) {
    assert.equal(typeof (Web3Auth.prototype as unknown as Record<string, unknown>)[m], "function", m);
  }
  assert.equal(CHAIN_NAMESPACES.OTHER, "other", "the key-only namespace still exists");
  assert.equal(CONNECTOR_EVENTS.CONNECTED, "connected");
});

test("both places that build the SDK go through the adapter", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
  const account = read("../src/lib/auth/web3auth-account.ts");
  const backup = read("../src/lib/wallet/backup-signer.ts");
  assert.ok(account.includes("adaptWeb3AuthSdk(new mod.Web3Auth(buildWeb3AuthOptions(mod, clientId))"));
  assert.ok(backup.includes("adaptWeb3AuthSdk(new mod.Web3Auth(buildWeb3AuthOptions(mod, clientId))"));
  assert.equal(account.match(/new mod\.Web3Auth\(/g)?.length, 1);
  assert.equal(backup.match(/new mod\.Web3Auth\(/g)?.length, 1);
});

test("connect() settles on CONNECTED: the options pin CONNECT_ONLY over v11's CONNECT_AND_SIGN default", async () => {
  const { CONNECTOR_INITIAL_AUTHENTICATION_MODE } = await import("@web3auth/modal");
  assert.equal(CONNECTOR_INITIAL_AUTHENTICATION_MODE.CONNECT_ONLY, "connect-only");
  const config = readFileSync(new URL("../src/lib/auth/web3auth-config.ts", import.meta.url), "utf8");
  const options = config.slice(config.indexOf("export function buildWeb3AuthOptions("));
  assert.ok(
    options.includes("initialAuthenticationMode: CONNECTOR_INITIAL_AUTHENTICATION_MODE.CONNECT_ONLY,"),
    "without it connect() never settles under CHAIN_NAMESPACES.OTHER",
  );
  // The SDK's own default, which the option overrides - if v11 ever changes it, re-check.
  const noModal = readFileSync(new URL("../node_modules/@web3auth/no-modal/dist/lib.esm/noModal.js", import.meta.url), "utf8");
  assert.ok(noModal.includes("options.initialAuthenticationMode = CONNECTOR_INITIAL_AUTHENTICATION_MODE.CONNECT_AND_SIGN"));
});

test("the email backup's login label reads v11's authConnection (typeOfLogin was v10's)", () => {
  const backup = readFileSync(new URL("../src/lib/wallet/backup-signer.ts", import.meta.url), "utf8");
  assert.ok(backup.includes("providerLabel = info?.authConnection || info?.typeOfLogin || undefined;"));
});
