/**
 * The no-records rule for private receipts (owner 2026-11-24, spec-receipt-note 5.2):
 * our server never writes down WHO collected or erased a receipt, nor who saved one into
 * an account. A guest saving a receipt sends, from one connection, an anonymous erase and
 * an account's storage save; only a record of the address or the account beside either
 * would let anyone at WoCo match the two later. Addresses live in the per-IP limiters'
 * memory only (`SlidingWindowLimiter`), never with a pickup id.
 *
 * Pinned on the source (Fable 3b condition 4 tightened it):
 * - every log line on the receipt routes, the receipt store, the storage relay and the
 *   middleware every request passes names no address, account, pickup id or email - by
 *   variable name or by a quoted key read (`c.get("parentAddress")`, a header);
 * - the sign-in check every relay save passes logs only on a REFUSED request, and only
 *   the lines reviewed here (each must be listed; a new one fails until reviewed);
 * - no log line reads the request itself (`c.req`) and no request logger is mounted.
 *
 * NOT covered (DATA_INVENTORY §3.3): the gateway (bee-proxy, another repo) logs every
 * request's address and path; Cloudflare sees addresses as our network provider.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const src = join(fileURLToPath(new URL(".", import.meta.url)), "../src");
const read = (rel: string) => readFileSync(join(src, rel), "utf8");

/** The receipt routes, the receipt store, the storage relay, and what every request passes through. */
const STRICT = [
  "routes/holdings.ts",
  "lib/holding/store.ts",
  "lib/holding/keep.ts",
  "lib/holding/due.ts",
  "routes/swarm.ts",
  "lib/swarm/soc-relay-limits.ts",
  "lib/swarm/soc-upload.ts",
  "middleware/custom-domain.ts",
  ...readdirSync(join(src, "lib/http")).filter((f) => f.endsWith(".ts")).map((f) => `lib/http/${f}`),
];

/**
 * The sign-in check on every relay save. Its log lines are REFUSALS only, reviewed one by
 * one: a refused session names the session key's address and the path; a refused wallet
 * or smart-wallet delegation names the account it claimed. A successful save logs nothing.
 */
const REVIEWED_REFUSALS: Record<string, string[]> = {
  "middleware/auth.ts": ["`[auth] reject ${status ?? \"soft\"} ${method} ${path} session=${session} `"],
  "lib/auth/verify-delegation.ts": [
    "`[auth] wallet delegation refused for ${message.parent}: walletLoginAllowed is off (#186)`",
    "`[auth] smart-wallet (1271/6492) verification not offered for ${message.parent}: coinbaseLoginAllowed is off (#173)`",
    "`[auth] smart-wallet verification not offered for ${message.parent}: ${gate.reason}`",
  ],
};

/** Each `console.*(...)` call's argument text, by balanced parentheses. */
function logCalls(text: string): string[] {
  const out: string[] = [];
  const re = /console\.(?:log|info|warn|error|debug|trace)\s*\(/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
    }
    out.push(text.slice(m.index, i));
  }
  return out;
}

/**
 * The CODE a call logs: plain string text removed, template interpolations kept - so
 * "the email goes now" passes and `${claimerEmail}` does not.
 */
function loggedCode(call: string): string {
  let out = "";
  for (let i = 0; i < call.length; i++) {
    const ch = call[i]!;
    if (ch === '"' || ch === "'") {
      for (i++; i < call.length && call[i] !== ch; i++) if (call[i] === "\\") i++;
      out += '""';
    } else if (ch === "`") {
      for (i++; i < call.length && call[i] !== "`"; i++) {
        if (call[i] === "\\") i++;
        else if (call[i] === "$" && call[i + 1] === "{") {
          let depth = 1;
          for (i += 2; i < call.length && depth > 0; i++) {
            if (call[i] === "{") depth++;
            else if (call[i] === "}") depth--;
            if (depth > 0) out += call[i];
          }
          out += " ";
          i--;
        }
      }
    } else out += ch;
  }
  return out;
}

const WHO = /\b(clientIp|ip|ips|parentAddress|parent|account|accounts|pickupId|pickupSigner|emailHash|claimerEmail|email|owner|holder|holders|header|headers|session|sessionAddress)\b/i;
/** A key READ by name, which strips to an empty string in `loggedCode`: `c.get("parentAddress")`, a header. */
const QUOTED_WHO = /["'`](parentAddress|sessionAddress|x-session-[a-z]+|cf-connecting-ip|x-forwarded-for|x-real-ip|forwarded)["'`]/i;
/** The request itself: its URL, path, headers or body. */
const READS_REQUEST = /\bc\.req\b|\breq\.(url|path|headers?)\b/;

function offences(call: string): string[] {
  const why: string[] = [];
  if (WHO.test(loggedCode(call))) why.push("names who");
  if (QUOTED_WHO.test(call)) why.push("reads a who-key by name");
  if (READS_REQUEST.test(loggedCode(call))) why.push("reads the request");
  return why;
}

test("no log line on the receipt and relay path names an address, an account, a pickup id or an email", () => {
  let seen = 0;
  for (const rel of STRICT) {
    for (const call of logCalls(read(rel))) {
      seen++;
      assert.deepEqual(offences(call), [], `${rel}: ${call}`);
    }
  }
  assert.ok(seen >= 9, "the scan found the log lines it is meant to guard");
});

test("the sign-in check logs only the refusals reviewed here - a new log line fails until reviewed", () => {
  for (const [rel, reviewed] of Object.entries(REVIEWED_REFUSALS)) {
    const calls = logCalls(read(rel));
    assert.equal(calls.length, reviewed.length, `${rel}: ${calls.length} log calls, ${reviewed.length} reviewed`);
    for (const call of calls) {
      assert.ok(reviewed.some((line) => call.includes(line)), `${rel}: not reviewed: ${call}`);
      assert.doesNotMatch(loggedCode(call), READS_REQUEST, `${rel}: a refusal line reads no request field itself`);
    }
  }
});

test("the guard itself catches a line that names who asked, and passes plain words", () => {
  const bad = [
    "console.log(`[holdings] pickup from ${clientIp(c)}`)",
    'console.warn("erase", pickupId)',
    "console.error(`${input.account} saved`)",
    'console.info(c.req.header("cf-connecting-ip"))',
    "console.warn(`[x] ${r.sessionId} for ${r.emailHash ?? \"none\"}`)",
    // Fable 3b: the idiom the relay uses to read the account, which strips to `c.get("")`.
    'console.log(c.get("parentAddress"))',
    "console.log(`saved by ${c.get('parentAddress')}`)",
    'console.log("saved", c.get("sessionAddress"))',
    "console.log(`${c.req.path}`)",
  ];
  for (const line of bad) assert.notDeepEqual(offences(logCalls(line)[0]!), [], line);
  const fine = "console.warn(`[holding] ${input.sessionId}: box store still running; the email goes now`)";
  assert.deepEqual(offences(logCalls(fine)[0]!), []);
});

test("no request logger, and no per-request log line, on the API server", () => {
  const index = read("index.ts");
  for (const rel of [...STRICT, "index.ts", ...Object.keys(REVIEWED_REFUSALS)]) {
    assert.doesNotMatch(read(rel), /from\s+["']hono\/logger["']/, rel);
  }
  for (const call of logCalls(index)) assert.doesNotMatch(loggedCode(call), READS_REQUEST, `index.ts: ${call}`);
});
