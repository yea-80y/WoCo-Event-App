/**
 * Issuing a door pass from the dashboard: challenge, then the pass with the order-key
 * proof - once more on "challenge-expired", never twice, and never on anything else.
 *
 * MUTATION: retry on any error and "anything else is not retried" goes red; retry without
 * a fresh challenge and "a fresh challenge" goes red; drop the retry and "expired once"
 * goes red; let it retry forever and "never a third" goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { hexToBytes } from "@noble/hashes/utils.js";
import type { DoorPassChallenge, DoorPassIssueRequest } from "@woco/shared";
import { doorKeyProof } from "@woco/shared/checkin/door-keys";
import { doorKeyProofSealContext, sealBox } from "@woco/shared/crypto/sealed-box";
import { deriveXWingKeypairFromSeed } from "@woco/shared/crypto/xwing";
import { issueDoorPassWithProof, type DoorPassApi } from "../src/lib/creator/dashboard/door-pass-issue.ts";

const SECRET = "11".repeat(32);
const EVENT = "0b3c5c1e-7d1a-4c55-9a8e-2f6d0e1b9c44";
const PARENT = "0x" + "aa".repeat(20);
const ORDER = deriveXWingKeypairFromSeed(SECRET);

/** A fake server: seals each challenge's nonce to the account's order key, checks proofs. */
function server(answers: Array<"ok" | "expired" | "other">) {
  const log: string[] = [];
  const nonces = new Map<string, Uint8Array>();
  const issued: DoorPassIssueRequest[] = [];
  let n = 0;
  const api: DoorPassApi = {
    async challenge(eventId) {
      const challengeId = (++n).toString(16).padStart(32, "0");
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      nonces.set(challengeId, nonce);
      log.push(`challenge ${challengeId.slice(-1)}`);
      const box = await sealBox(ORDER.publicKey, nonce, doorKeyProofSealContext(eventId, PARENT, challengeId));
      return { challengeId, box, exp: 0 } satisfies DoorPassChallenge;
    },
    async issue(eventId, req) {
      log.push(`issue ${req.challengeId.slice(-1)}`);
      issued.push(req);
      const want = doorKeyProof(nonces.get(req.challengeId)!, {
        eventId, parent: PARENT, challengeId: req.challengeId, jti: req.jti, mode: req.mode,
        doorKeyRef: (await import("@woco/shared/checkin/door-keys")).doorKeyRefOf(hexToBytes(req.doorKey)),
      });
      assert.equal(req.proof, want, "the proof answers this challenge");
      assert.equal((req as unknown as Record<string, unknown>).nonce, undefined, "the nonce never travels");
      const a = answers.shift() ?? "ok";
      if (a === "expired") throw Object.assign(new Error("That took too long"), { reason: "challenge-expired" });
      if (a === "other") throw Object.assign(new Error("nope"), { reason: "keys-changed" });
      return { token: "tok", exp: 1, mode: req.mode };
    },
  };
  return { api, log, issued };
}

const opts = { eventId: EVENT, parent: PARENT, mode: "single" as const, secrets: { current: SECRET } };

test("challenge, then the pass with a proof for that challenge", async () => {
  const s = server(["ok"]);
  const out = await issueDoorPassWithProof(opts, s.api);
  assert.equal(out.token, "tok");
  assert.deepEqual(s.log, ["challenge 1", "issue 1"]);
  assert.equal(s.issued[0]!.mode, "single");
});

test("challenge-expired: one more go, with a fresh challenge and the same pass id", async () => {
  const s = server(["expired", "ok"]);
  await issueDoorPassWithProof(opts, s.api);
  assert.deepEqual(s.log, ["challenge 1", "issue 1", "challenge 2", "issue 2"]);
  assert.equal(s.issued[0]!.jti, s.issued[1]!.jti);
});

test("expired twice: never a third", async () => {
  const s = server(["expired", "expired", "ok"]);
  await assert.rejects(issueDoorPassWithProof(opts, s.api), /too long/);
  assert.equal(s.log.filter((l) => l.startsWith("issue")).length, 2);
});

test("anything else is not retried", async () => {
  const s = server(["other", "ok"]);
  await assert.rejects(issueDoorPassWithProof(opts, s.api), /nope/);
  assert.deepEqual(s.log, ["challenge 1", "issue 1"]);
});
