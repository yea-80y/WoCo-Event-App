/**
 * A scanner that reads no seats (no `X-Scanner-Pack: 2`) must not admit a seated
 * ticket: the server records a claim it never verified. Such scanners update
 * themselves on `reason: "outdated-client"`.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { SCANNER_OUTDATED_REASON, SCANNER_PACK_HEADER } from "@woco/shared";

let store: typeof import("../src/lib/checkin/store.js");
let app: Hono;

const LEDGER2 = { chainId: 42161, address: "0x" + "5c".repeat(20), version: "ledger2" as const };

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-checkin-pack-version-")));
  process.env.CHECKIN_PASS_SECRET = "test-secret-for-pack-versions";
  store = await import("../src/lib/checkin/store.js");
  const registry = await import("../src/lib/event/onchain-registry.js");
  registry.recordOnChainEventId("evt-seated", "ser-seated", "0x" + "7e".repeat(32), LEDGER2, { planDigest: "0x" + "ab".repeat(32) });
  registry.recordOnChainEventId("evt-seated", "ser-ga", "0x" + "7f".repeat(32), LEDGER2);
  const { checkin } = await import("../src/routes/checkin.js");
  app = new Hono();
  app.route("/api/checkin", checkin);
});

function claim(token: string, seriesId: string, pack?: string, claimId = `c-${seriesId}-${pack ?? "none"}`) {
  return app.request("/api/checkin/evt-seated/claim", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Door-Pass": token,
      "X-Scanner-Device": "deviceaaaaaaaaaa",
      ...(pack ? { [SCANNER_PACK_HEADER]: pack } : {}),
    },
    body: JSON.stringify({ seriesId, edition: 3, method: "scan", claimId, at: "2026-11-04T21:00:00.000Z" }),
  });
}

test("a scanner without seats is refused a seated ticket's claim, and told to update", async () => {
  const token = store.issueDoorPass("evt-seated", Math.floor(Date.now() / 1000) + 3600);
  const res = await claim(token, "ser-seated");
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { reason?: string }).reason, SCANNER_OUTDATED_REASON);
  assert.equal((await claim(token, "ser-seated", "1")).status, 400, "version 1 is the same as none");
});

test("a scanner that reads seats claims it; general admission is unaffected for old scanners", async () => {
  const token = store.issueDoorPass("evt-seated", Math.floor(Date.now() / 1000) + 3600);
  assert.equal((await claim(token, "ser-seated", "2")).status, 200);
  assert.equal((await claim(token, "ser-ga")).status, 200);
});
