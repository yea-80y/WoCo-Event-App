/**
 * The no-records rule for private receipts (owner 2026-11-24, spec-receipt-note 5.2):
 * our server never writes down WHO collected or erased a receipt, nor who saved one into
 * an account. A guest saving a receipt sends, from one connection, an anonymous erase and
 * an account's storage save; only a record of the address or the account beside either
 * would let anyone at WoCo match the two later. Addresses live in the per-IP limiters'
 * memory only (`SlidingWindowLimiter`), never with a pickup id.
 *
 * Pinned on the source: every log line on the receipt routes, the receipt store and the
 * storage relay names no address, account, pickup id or email; and no request logger is
 * mounted on those routes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const src = join(fileURLToPath(new URL(".", import.meta.url)), "../src");
const FILES = [
  "routes/holdings.ts",
  "lib/holding/store.ts",
  "lib/holding/keep.ts",
  "lib/holding/due.ts",
  // The storage relay every account save goes through.
  "routes/swarm.ts",
  "lib/swarm/soc-relay-limits.ts",
  "lib/swarm/soc-upload.ts",
];

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

const WHO = /\b(clientIp|ip|ips|parentAddress|parent|account|accounts|pickupId|pickupSigner|emailHash|claimerEmail|email|owner|holder|holders|header|headers)\b/i;

test("no log line on the receipt or relay path names an address, an account, a pickup id or an email", () => {
  let seen = 0;
  for (const rel of FILES) {
    const text = readFileSync(join(src, rel), "utf8");
    for (const call of logCalls(text)) {
      seen++;
      assert.doesNotMatch(loggedCode(call), WHO, `${rel}: ${call}`);
    }
  }
  assert.ok(seen >= 8, "the scan found the log lines it is meant to guard");
});

test("the guard itself catches a line that names who asked, and passes plain words", () => {
  const bad = [
    "console.log(`[holdings] pickup from ${clientIp(c)}`)",
    'console.warn("erase", pickupId)',
    "console.error(`${input.account} saved`)",
    'console.info(c.req.header("cf-connecting-ip"))',
    "console.warn(`[x] ${r.sessionId} for ${r.emailHash ?? \"none\"}`)",
  ];
  for (const line of bad) assert.match(loggedCode(logCalls(line)[0]!), WHO, line);
  const fine = "console.warn(`[holding] ${input.sessionId}: box store still running; the email goes now`)";
  assert.doesNotMatch(loggedCode(logCalls(fine)[0]!), WHO);
});

test("no request logger on the receipt routes or the relay", () => {
  for (const rel of ["routes/holdings.ts", "routes/swarm.ts", "index.ts"]) {
    const text = readFileSync(join(src, rel), "utf8");
    assert.doesNotMatch(text, /from\s+["']hono\/logger["']/, rel);
  }
});
