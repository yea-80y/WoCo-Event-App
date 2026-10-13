/**
 * Email sign-in on iPhone: the address is normalised (trimmed, lower-cased)
 * before it becomes Web3Auth's login identifier (web3auth-sdk-adapter.ts).
 *
 * The iPhone's "Show details" (2026-10-12): "Error occurred while verifying params
 * could not verify identity [email] [email]" - Web3Auth's documented error for a
 * user identifier that does not match the verified token's; identifiers are
 * case-sensitive by default. The modal's email box is a plain text input with no
 * `autocapitalize`, iOS capitalises the first letter, and the modal passes the
 * address on as typed. The code still arrives (mail ignores case); the identity
 * check does not.
 *
 * MUTATIONS (each went red, then restored): normalisation dropped from the
 * adapter; lower-casing dropped (trim only); applied to every connection (Google's
 * params touched); extraLoginOptions.login_hint left as typed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mod = await import("@web3auth/modal");
const { adaptWeb3AuthSdk, normalizeEmailLoginParams, EMAIL_PASSWORDLESS } = await import("../src/lib/auth/web3auth-sdk-adapter.ts");
const { web3AuthOptionsFor } = await import("../src/lib/auth/web3auth-config.ts");

test("normalise: an email sign-in's address is trimmed and lower-cased - nothing else changes, no other login touched", () => {
  const typed = {
    authConnection: EMAIL_PASSWORDLESS,
    authConnectionId: "w3a-email-passwordless",
    groupedAuthConnectionId: "w3a-group",
    loginHint: " Someone.Name@Example.COM ",
    extraLoginOptions: { login_hint: "Someone.Name@Example.COM", other: "Kept As Is" },
  };
  assert.deepEqual(normalizeEmailLoginParams(typed), {
    ...typed,
    loginHint: "someone.name@example.com",
    extraLoginOptions: { login_hint: "someone.name@example.com", other: "Kept As Is" },
  });
  assert.equal(typed.loginHint, " Someone.Name@Example.COM ", "the caller's object is not mutated");
  const google = { authConnection: "google", loginHint: "Someone@Example.com" };
  assert.equal(normalizeEmailLoginParams(google), google, "only the email connection");
  assert.equal(normalizeEmailLoginParams(undefined), undefined);
  // The connection ids - which decide WHICH key - are passed through untouched.
  const out = normalizeEmailLoginParams(typed);
  assert.equal(out.authConnectionId, typed.authConnectionId);
  assert.equal(out.groupedAuthConnectionId, typed.groupedAuthConnectionId);
});

/** The prototype that owns the SDK's public connectTo. */
function connectToOwner(o: object): { connectTo: (...a: unknown[]) => unknown } {
  let p: object | null = Object.getPrototypeOf(o);
  while (p && !Object.prototype.hasOwnProperty.call(p, "connectTo")) p = Object.getPrototypeOf(p);
  assert.ok(p, "connectTo exists on the SDK");
  return p as { connectTo: (...a: unknown[]) => unknown };
}

test("the REAL modal's own email button path (onSocialLogin -> this.connectTo) reaches the SDK with the normalised address", async () => {
  const probe = new mod.Web3Auth(web3AuthOptionsFor(mod, "BPi5_test", "sapphire_mainnet") as never);
  const owner = connectToOwner(probe);
  const original = owner.connectTo;
  const seen: unknown[][] = [];
  owner.connectTo = async function (...args: unknown[]) {
    seen.push(args);
    return null;
  };
  try {
    const sdk = new mod.Web3Auth(web3AuthOptionsFor(mod, "BPi5_test", "sapphire_mainnet", "redirect") as never);
    adaptWeb3AuthSdk(sdk as never);
    // What the modal's Login.js isDefault branch hands its onSocialLogin callback.
    await (sdk as unknown as { onSocialLogin: (p: unknown) => Promise<void> }).onSocialLogin({
      loginParams: {
        authConnection: EMAIL_PASSWORDLESS,
        authConnectionId: "w3a-email-passwordless",
        groupedAuthConnectionId: "w3a-group",
        loginHint: "Someone@example.com",
      },
    });
    assert.equal(seen.length, 1);
    const [connector, params] = seen[0] as [string, { loginHint: string; authConnectionId: string }];
    assert.equal(connector, "auth");
    assert.equal(params.loginHint, "someone@example.com");
    assert.equal(params.authConnectionId, "w3a-email-passwordless");
  } finally {
    owner.connectTo = original;
  }
});

const src = (rel: string) => readFileSync(new URL(`../node_modules/${rel}`, import.meta.url), "utf8").replace(/\s+/g, " ");
const ui = "@web3auth/modal/dist/lib.esm/packages/modal/src";

test("SDK: why - the modal's email box lets iOS capitalise, and the address goes on as typed", () => {
  const input = src(`${ui}/ui/containers/Login/LoginPasswordLess/LoginPasswordLess.js`);
  assert.match(input, /type: "text", className:/);
  assert.ok(!/autoCapitalize|autocapitalize/.test(input), "no autocapitalize on the email box");
  const login = src(`${ui}/ui/containers/Login/Login.js`);
  assert.match(login, /const isEmailValid = loginHint\.match\(\/\^\(\[\\w\.%\+-\]\+\)@\(\[\\w-\]\+\\\.\)\+\(\[\\w\]\{2,\}\)\$\/i\);/);
  assert.ok(!/loginHint\.toLowerCase\(\)/.test(login), "the modal never lower-cases it");
  // ...and its email button signs in through the PUBLIC connectTo, on the instance.
  const manager = src(`${ui}/modalManager.js`);
  assert.match(manager, /await this\.connectTo\(WALLET_CONNECTORS\.AUTH, params\.loginParams, LOGIN_MODE\.MODAL\);/);
  // The address becomes the login hint the identity is checked against.
  const connector = src("@web3auth/no-modal/dist/lib.esm/connectors/auth-connector/authConnector.js");
  assert.match(connector, /login_hint: params\.loginHint \|\|/);
});

test("both places that build the SDK adapt it, so the email backup is normalised too", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
  for (const f of ["../src/lib/auth/web3auth-account.ts", "../src/lib/wallet/backup-signer.ts"]) {
    assert.match(read(f), /adaptWeb3AuthSdk\(new mod\.Web3Auth\(/, f);
  }
});
