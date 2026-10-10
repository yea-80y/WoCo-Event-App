import { FEATURES } from "@woco/shared";

/**
 * Turn a launch-off feature on for THIS test file (node --test runs each file in its
 * own process, and the server reads FEATURES at call time).
 *
 * `walletLoginAllowed`: route tests sign in with a plain wallet as the cheapest
 * stand-in for "a verified account", and the server refuses those delegations while
 * wallet login is off (#186). The refusal itself is pinned in wallet-login-gate.test.ts.
 * `accountBackupsAllowed`: the sponsorship tests of the backup ops.
 */
export function enableFeature(name: "walletLoginAllowed" | "accountBackupsAllowed", on = true): void {
  (FEATURES as Record<string, boolean>)[name] = on;
}
