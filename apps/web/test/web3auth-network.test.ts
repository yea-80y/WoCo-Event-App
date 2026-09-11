/**
 * The Web3Auth network must FAIL CLOSED (#244).
 *
 * The replaced code was `?? "sapphire_devnet"`, which made two different mistakes
 * indistinguishable from a correct config: an UNSET variable (every fresh clone,
 * every git worktree, every CI runner — `apps/web/.env` is gitignored) and a value
 * that merely looks configured ("sapphire-mainnet", "mainnet", a stray space).
 * Both silently selected the development network, which derives a DIFFERENT key
 * for every Web3Auth account.
 *
 * So the property pinned here is refusal, and refusal without repair: no trim, no
 * case-fold, and an error that names the offending value so an operator can see
 * what they typed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWeb3AuthNetwork, WEB3AUTH_NETWORK_ENV_VAR } from "../src/lib/auth/web3auth-network.js";
import { buildWeb3AuthOptions } from "../src/lib/auth/web3auth-config.js";

test("the two exact names resolve to themselves", () => {
  assert.equal(resolveWeb3AuthNetwork("sapphire_mainnet"), "sapphire_mainnet");
  assert.equal(resolveWeb3AuthNetwork("sapphire_devnet"), "sapphire_devnet");
});

test("unset refuses, and says so rather than naming a value nobody typed", () => {
  assert.throws(
    () => resolveWeb3AuthNetwork(undefined),
    (e: unknown) => {
      const msg = (e as Error).message;
      assert.match(msg, new RegExp(WEB3AUTH_NETWORK_ENV_VAR));
      assert.match(msg, /unset/);
      assert.match(msg, /sapphire_mainnet/);
      assert.match(msg, /sapphire_devnet/);
      return true;
    },
  );
});

test("every near-miss refuses, and the message quotes what was actually given", () => {
  // Each of these reads as "configured" at a glance — that is the whole danger.
  for (const raw of ["", "sapphire-mainnet", "mainnet", "SAPPHIRE_MAINNET", " sapphire_mainnet", "sapphire_devnet "]) {
    assert.throws(
      () => resolveWeb3AuthNetwork(raw),
      (e: unknown) => {
        const msg = (e as Error).message;
        assert.ok(msg.includes(`"${raw}"`), `message should quote the offending value, got: ${msg}`);
        assert.match(msg, new RegExp(WEB3AUTH_NETWORK_ENV_VAR));
        return true;
      },
      `expected ${JSON.stringify(raw)} to be refused`,
    );
  }
});

test("buildWeb3AuthOptions throws rather than falling back to devnet", () => {
  // Node has no `import.meta.env`, so the network reads as unset here — which is
  // exactly the case the old `??` swallowed. The mod is the minimum
  // `buildWeb3AuthOptions` destructures; if it ever returns instead of throwing,
  // these constants are what it would have handed the SDK.
  const mod = {
    WEB3AUTH_NETWORK: { SAPPHIRE_MAINNET: "sapphire_mainnet", SAPPHIRE_DEVNET: "sapphire_devnet" },
    CHAIN_NAMESPACES: { OTHER: "other" },
  } as unknown as Parameters<typeof buildWeb3AuthOptions>[0];

  assert.throws(
    () => buildWeb3AuthOptions(mod, "test-client-id"),
    (e: unknown) => {
      assert.match((e as Error).message, new RegExp(WEB3AUTH_NETWORK_ENV_VAR));
      return true;
    },
  );
});
