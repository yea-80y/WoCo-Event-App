/**
 * Where the #803 rules sit in the Web3Auth call sites. The behaviour is
 * unit-tested in web3auth-survivor.test.ts; what those tests cannot see is that
 * every explicit sign-in goes through the fresh-instance rule, and that the boot
 * restore reads a session still loading as transient.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const account = read("../src/lib/auth/web3auth-account.ts");
const backup = read("../src/lib/wallet/backup-signer.ts");
const config = read("../src/lib/auth/web3auth-config.ts");

function body(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  const end = src.indexOf("\nexport async function ", start + 10);
  return src.slice(start, end < 0 ? undefined : end);
}

test("primary sign-in: survivors are ended through the fresh-instance rule, before connect()", () => {
  const login = body(account, "export async function loginWithWeb3Auth(");
  const rule = login.indexOf("w = await instanceForExplicitSignIn(w,");
  const connect = login.indexOf("await w.connect()");
  assert.ok(rule > 0 && connect > rule, "connect() only on the instance the rule hands back");
  assert.ok(!login.includes("endSurvivingWeb3AuthSession("), "never end a survivor and keep the instance");
});

test("backup sign-in: the same rule, and connect() on the instance it hands back", () => {
  const connect = body(backup, "export async function connectWeb3AuthBackup(");
  const rule = connect.indexOf("await instanceForExplicitSignIn(asSurvivor(web3auth), async () => asSurvivor(await build()))");
  const swap = connect.indexOf("web3auth = ready as unknown as Instance;");
  const open = connect.indexOf("provider = await web3auth.connect();");
  assert.ok(rule > 0 && swap > rule && open > swap, "connect() runs on the instance the rule returned");
  assert.ok(!connect.includes("endSurvivingWeb3AuthSession("), "never end a survivor and keep the instance");
});

test("boot restore: a session still loading returns unavailable before any expired verdict", () => {
  const restore = body(account, "export async function restoreWeb3AuthSession(");
  const verdict = restore.indexOf("const verdict = restoreVerdict(rehydration, w.connected && !!w.provider);");
  const unavailable = restore.indexOf('if (verdict === "unavailable") {', verdict);
  const expired = restore.indexOf('if (verdict === "expired" || !w.provider) {', verdict);
  assert.ok(verdict > 0 && unavailable > verdict && expired > unavailable);
  assert.ok(
    restore.slice(unavailable, expired).includes('return { status: "unavailable" };'),
    "still loading keeps the session (the caller retries)",
  );
});

test("every instance asks for the 30-day session, the SDK's maximum", async () => {
  const { WEB3AUTH_SESSION_SECONDS } = await import("../src/lib/auth/web3auth-config.js");
  assert.equal(WEB3AUTH_SESSION_SECONDS, 30 * 86400);
  const options = config.slice(config.indexOf("export function buildWeb3AuthOptions("));
  assert.ok(options.includes("sessionTime: WEB3AUTH_SESSION_SECONDS,"), "unset = the dashboard's 1 day");
});
