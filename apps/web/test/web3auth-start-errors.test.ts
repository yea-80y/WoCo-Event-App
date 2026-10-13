/**
 * The auth connector's start-up failure, recovered from the SDK's own logger
 * (web3auth-start-errors.ts), against the REAL `log` that `@web3auth/modal`
 * exports and the real modal source that logs it.
 *
 * MUTATIONS (each went red, then restored): the connector-name check dropped
 * (another connector's failure taken); the message check dropped; the off
 * switch not restoring the logger; the off switch not muting a layer something
 * else chained over.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mod = await import("@web3auth/modal");
const { tapConnectorStartErrors, CONNECTOR_INIT_FAILED_LOG } = await import("../src/lib/auth/web3auth-start-errors.ts");
type TappableLog = import("../src/lib/auth/web3auth-start-errors.ts").TappableLog;

const log = mod.log as unknown as TappableLog & { error: (...a: unknown[]) => void; setLevel(l: string): void };

/** Silence the SDK's console output for the test, whatever loglevel binds. */
function quietly<T>(fn: () => T): T {
  const saved = console.error;
  console.error = () => {};
  try {
    log.rebuild();
    return fn();
  } finally {
    console.error = saved;
    log.rebuild();
  }
}

test("the modal's own failure line for the auth connector reaches us, as the error object itself", () => {
  quietly(() => {
    const seen: unknown[] = [];
    const off = tapConnectorStartErrors(log, (e) => seen.push(e));
    const boom = Object.assign(new Error("Login failed"), { name: "LoginError", code: 5102 });
    log.error(boom, "error while initializing connector ", "auth");
    log.error(new Error("other"), "error while initializing connector ", "metamask");
    log.error(new Error("unrelated"), "something else", "auth");
    log.error("Some reason Web3Auth's frame gives", "error while initializing connector", "auth");
    off();
    log.error(new Error("after"), "error while initializing connector ", "auth");
    assert.deepEqual(seen, [boom, "Some reason Web3Auth's frame gives"]);
  });
});

test("the off switch puts the logger back exactly, and a tap under another layer goes quiet", () => {
  const before = log.methodFactory;
  const off = tapConnectorStartErrors(log, () => {});
  assert.notEqual(log.methodFactory, before);
  off();
  assert.equal(log.methodFactory, before, "restored exactly");

  quietly(() => {
    const seen: unknown[] = [];
    const offA = tapConnectorStartErrors(log, (e) => seen.push(e));
    const offB = tapConnectorStartErrors(log, () => {});
    offA(); // out of order: B is on top, so A becomes a pass-through
    log.error(new Error("x"), CONNECTOR_INIT_FAILED_LOG, "auth");
    offB();
    assert.deepEqual(seen, []);
  });
  assert.equal(typeof log.methodFactory, "function");
});

test("SDK: a connector that fails to start is only LOGGED with these words - no event reaches the page", () => {
  const m = readFileSync(new URL("../node_modules/@web3auth/modal/dist/lib.esm/packages/modal/src/modalManager.js", import.meta.url), "utf8");
  const flat = m.replace(/\s+/g, " ");
  assert.match(flat, /\} catch \(error\) \{ log\.error\(error, "error while initializing connector ", connectorName\); \}/);
  assert.equal(CONNECTOR_INIT_FAILED_LOG, "error while initializing connector");
  // ...and it is the PUBLIC logger: the package exports it.
  assert.equal(typeof mod.log.error, "function");
  const auth = readFileSync(new URL("../node_modules/@web3auth/auth/dist/lib.esm/core/auth.js", import.meta.url), "utf8").replace(/\s+/g, " ");
  // The silent exits of the nonce branch this recovers.
  assert.match(auth, /await this\.postLoginInitiatedMessage\(JSON\.parse\(params\.loginParams\), params\.nonce\);/);
  assert.match(auth, /this\.clearState\(\); throw LoginError\.userNotLoggedIn\(\);/);
});
