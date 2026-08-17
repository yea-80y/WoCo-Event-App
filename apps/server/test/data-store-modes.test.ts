/**
 * Every `.data` store lands owner-only, on the write that CREATES it (#130).
 *
 * The 0600-by-construction guarantee lives in `writeJsonAtomic`, but twenty-odd
 * stores wrote their own `writeFileSync(file, json)` with no mode, so a fresh
 * deployment created them at the container umask — 0644 — until an operator ran
 * the runbook sweep. That is not hypothetical: the door-scanner smoke test on
 * 2026-08-09 found `checkin-rosters/*.json` and `checkins/*.json` at 0644, minutes
 * old, on a VM where every older file was 0600.
 *
 * Two guarantees are pinned here:
 *
 *   1. PER STORE. Drive each store's real write path against a temp cwd and check
 *      what actually landed on disk. `.data` itself must be 0700, and every file
 *      and directory under it 0600 / 0700 — so a store that writes a file this
 *      test does not know the name of is still caught.
 *
 *   2. THE RATCHET. No module may reach for a raw file-write primitive again.
 *      This is the guarantee that matters: the mode was fixed once before, in
 *      2026-07, and the stores added AFTER that fix are exactly the ones that
 *      shipped at 0644. A sweep that is not enforced is a sweep that decays.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SubjectType } from "@woco/shared";

const OWNER = "0x1111111111111111111111111111111111111111";
const ADDR2 = "0x2222222222222222222222222222222222222222";
const BYTES32 = `0x${"ab".repeat(32)}`;

let dir: string;
let dataDir: string;
let originalCwd: string;

before(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "woco-store-modes-"));
  dataDir = join(dir, ".data");
  // Each store captures `join(process.cwd(), ".data")` at module load, so the
  // chdir has to happen before the first dynamic import below.
  process.chdir(dir);
  process.env.CHECKIN_PASS_SECRET ??= "test-door-pass-secret";
});

after(() => {
  process.chdir(originalCwd);
});

// ---------------------------------------------------------------------------
// 1. Per store
// ---------------------------------------------------------------------------

/** Everything under `.data` that is not owner-only, as "path mode" strings. */
function looseModes(root: string): string[] {
  const bad: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      const mode = statSync(p).mode & 0o777;
      const want = entry.isDirectory() ? 0o700 : 0o600;
      if (mode !== want) bad.push(`${relative(root, p)} is ${mode.toString(8)}, want ${want.toString(8)}`);
      if (entry.isDirectory()) walk(p);
    }
  };
  walk(root);
  return bad;
}

/**
 * `campaign/badges.ts` and `shop/spend-permission.ts` are absent: their only
 * write paths go through an on-chain attestation and a verified USDC transfer
 * respectively, so driving them here would mean mocking a chain. The ratchet
 * below is what covers them.
 */
const CASES: Array<{ store: string; drive: () => Promise<unknown> | unknown }> = [
  {
    store: "auth/revocation",
    drive: async () => {
      const m = await import("../src/lib/auth/revocation.js");
      m.revokeSession("nonce-1", new Date(Date.now() + 3_600_000).toISOString());
    },
  },
  {
    store: "campaign/referral-store",
    drive: async () => {
      const m = await import("../src/lib/campaign/referral-store.js");
      m.setPendingReferral(OWNER, ADDR2);
    },
  },
  {
    // The store caught at 0644 in production: three files, two of them in
    // subdirectories the writer creates itself.
    store: "checkin/store",
    drive: async () => {
      const m = await import("../src/lib/checkin/store.js");
      m.issueDoorPass("event-1", Math.floor(Date.now() / 1000) + 3600);
      m.storeRoster("event-1", { iv: "aa", ciphertext: "bb", updatedAt: new Date().toISOString() });
      m.mergeCheckins("event-1", [
        { seriesId: "series-1", edition: 1, at: new Date().toISOString(), deviceId: "dev-1", method: "scan" },
      ]);
    },
  },
  {
    store: "domains/service",
    drive: async () => {
      const m = await import("../src/lib/domains/service.js");
      // `.test` never resolves and detectProvider swallows the DNS failure.
      await m.registerDomain("example.test", { siteId: "site-1" }, "feed-1", "hash-1", OWNER);
    },
  },
  {
    store: "etherna/batches",
    drive: async () => {
      const m = await import("../src/lib/etherna/batches.js");
      const now = new Date().toISOString();
      m.saveUserBatch(OWNER, {
        batchId: "batch-1",
        depth: 20,
        ttlDays: 30,
        purchasedAt: now,
        expiresAt: now,
        paidUntil: now,
        gateway: "https://gateway.etherna.io",
      });
    },
  },
  {
    store: "event/listing-state",
    drive: async () => {
      const m = await import("../src/lib/event/listing-state.js");
      m.setListed("event-1", true);
    },
  },
  {
    store: "event/onchain-registry",
    drive: async () => {
      const m = await import("../src/lib/event/onchain-registry.js");
      m.recordOnChainEventId("event-1", "series-1", BYTES32);
      m.recordPendingRegistration("event-1", "series-2", { txHash: BYTES32, nonce: 1, chainId: 421614 });
    },
  },
  {
    store: "event/reservation-store",
    drive: async () => {
      const m = await import("../src/lib/event/reservation-store.js");
      await m.reserve("event-1", "series-1", 1, async () => 10);
    },
  },
  {
    store: "gate/store",
    drive: async () => {
      const m = await import("../src/lib/gate/store.js");
      m.bindTicket({ seriesId: "series-1", edition: 1, eventId: "event-1", parentAddress: OWNER, route: "claim" });
    },
  },
  {
    store: "likes/index-store",
    drive: async () => {
      const m = await import("../src/lib/likes/index-store.js");
      await m.recordLike({ subject: BYTES32, subjectType: SubjectType.Profile, attester: OWNER, uid: BYTES32 });
    },
  },
  {
    store: "marketing/consumed-webhook-events",
    drive: async () => {
      const m = await import("../src/lib/marketing/consumed-webhook-events.js");
      m.checkAndConsumeWebhookEvent("msg_1");
    },
  },
  {
    store: "marketing/send-cap",
    drive: async () => {
      const m = await import("../src/lib/marketing/send-cap.js");
      m.recordSend(OWNER, 1);
    },
  },
  {
    store: "marketing/sending-domain-store",
    drive: async () => {
      const m = await import("../src/lib/marketing/sending-domain-store.js");
      const now = new Date().toISOString();
      m.putDomain(OWNER, {
        resendDomainId: "rd_1",
        domain: "example.test",
        fromLocalPart: "hello",
        status: "pending",
        records: [],
        createdAt: now,
        updatedAt: now,
      });
    },
  },
  {
    store: "payment/quote",
    drive: async () => {
      const m = await import("../src/lib/payment/quote.js");
      m.consumeQuote("quote-1");
    },
  },
  {
    store: "payment/tx-registry",
    drive: async () => {
      const m = await import("../src/lib/payment/tx-registry.js");
      m.checkAndConsumeTxHash(BYTES32);
    },
  },
  {
    store: "shop/quote",
    drive: async () => {
      const m = await import("../src/lib/shop/quote.js");
      m.consumeShopQuote("shop-quote-1");
    },
  },
  {
    store: "stripe/accounts",
    drive: async () => {
      const m = await import("../src/lib/stripe/accounts.js");
      m.setStripeAccount(OWNER, "acct_1", false, "gbp");
    },
  },
  {
    store: "stripe/payout-intents",
    drive: async () => {
      const m = await import("../src/lib/stripe/payout-intents.js");
      m.saveIntent({
        stripeAccountId: "acct_1",
        currency: "gbp",
        sessionIds: ["cs_1"],
        forcedSessionIds: [],
        amount: 1000,
        idempotencyKey: "key-1",
        createdAt: new Date().toISOString(),
      });
    },
  },
  {
    store: "stripe/payout-ledger",
    drive: async () => {
      const m = await import("../src/lib/stripe/payout-ledger.js");
      m.recordHeld({
        sessionId: "cs_1",
        stripeAccountId: "acct_1",
        organiserAddress: OWNER,
        kind: "event",
        currency: "gbp",
        grossAmount: 1000,
        releaseAfter: new Date().toISOString(),
      });
    },
  },
  {
    store: "stripe/requirement-nudge",
    drive: async () => {
      const m = await import("../src/lib/stripe/requirement-nudge.js");
      const now = new Date().toISOString();
      m.setNudgeState("acct_1", { signature: "sig", firstDueAt: now, lastNotifiedAt: now });
    },
  },
  {
    store: "stripe/session-registry",
    drive: async () => {
      const m = await import("../src/lib/stripe/session-registry.js");
      m.checkAndConsumeSession("cs_1");
    },
  },
  {
    store: "swarm/storage-ledger",
    drive: async () => {
      const m = await import("../src/lib/swarm/storage-ledger.js");
      m.recordUpload(OWNER, { ref: "ab".repeat(32), bytes: 1, kind: "test", batchId: "batch-1", target: "wocoBee" });
    },
  },
];

/** Already-blamed paths, so one loose store fails one test and not every test after it. */
const reported = new Set<string>();

for (const c of CASES) {
  test(`${c.store} creates its store owner-only`, async () => {
    await c.drive();
    // The whole tree, not just this store's file: earlier cases have already
    // passed, so a NEW offender belongs to the store just driven — including
    // files it names itself, like the per-event check-in rosters.
    const fresh = looseModes(dataDir).filter((p) => !reported.has(p));
    for (const p of fresh) reported.add(p);
    assert.deepEqual(fresh, []);
  });
}

test(".data itself is owner-only, created by the first store that needed it", () => {
  assert.equal(statSync(dataDir).mode & 0o777, 0o700);
});

/**
 * The stores an operator reads by hand (`docs/NEXT.md`: "ledger = docker compose
 * exec server cat .data/storage-ledger.json") stay indented. Moving a store onto
 * a shared writer must not silently reformat its file.
 */
test("the hand-read stores keep their indentation, and the machine-read ones stay compact", () => {
  assert.match(readFileSync(join(dataDir, "storage-ledger.json"), "utf-8"), /\n {2}"0x/);
  assert.match(readFileSync(join(dataDir, "stripe-accounts.json"), "utf-8"), /\n {2}"0x/);
  assert.doesNotMatch(readFileSync(join(dataDir, "consumed-stripe-sessions.json"), "utf-8"), /\n/);
});

// ---------------------------------------------------------------------------
// 2. The ratchet
// ---------------------------------------------------------------------------

/** Raw write primitives. `openSync` is included because that is how a store would
 *  hand-roll its way around `writeFileSync` while still creating a 0644 file. */
const RAW_WRITE = /\b(writeFileSync|appendFileSync|openSync|createWriteStream)\s*\(|\bfs\.(writeFile|appendFile)\s*\(/;

/**
 * Every file allowed to write bytes itself, and why. A new entry here is a
 * deliberate decision to opt out of the 0600 guarantee — not a formality.
 */
const ALLOWED: Record<string, string> = {
  "lib/marketing/persist.ts": "the implementation — openSync + fchmod IS the guarantee",
  "lib/email/broadcast-jobs.ts": "sealed recipient chunks are ciphertext, not JSON, and pass mode 0600 explicitly",
  "routes/site.ts": "stages a deploy tar under /tmp; nothing under .data",
  "routes/sites.ts": "stages a deploy tar under /tmp; nothing under .data",
};

/** Comments talk about `writeFileSync` a lot; only code counts. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("no module writes files itself — writeJsonAtomic is the only way into .data", () => {
  const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
  const offenders: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".ts") && RAW_WRITE.test(stripComments(readFileSync(p, "utf-8")))) {
        offenders.push(relative(srcRoot, p));
      }
    }
  };
  walk(srcRoot);

  assert.deepEqual(
    offenders.sort(),
    Object.keys(ALLOWED).sort(),
    "a module writes files directly. Use writeJsonAtomic — or, if it genuinely " +
      "cannot, add it to ALLOWED with the reason. Stale entries belong here too: " +
      "a file that stopped writing must leave the list.",
  );
});
