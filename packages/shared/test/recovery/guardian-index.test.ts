import test from "node:test";
import assert from "node:assert/strict";
import {
  GUARDIAN_ACCOUNT_INDEX_FORMAT,
  MAX_GUARDIAN_INDEX_ACCOUNTS,
  emptyGuardianAccountIndex,
  isGuardianAccountIndex,
  orderGuardianCandidates,
  upsertGuardianAccount,
} from "../../src/recovery/guardian-index.js";

const K = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

test("validator accepts the shape the writer produces and rejects foreign payloads", () => {
  const r = upsertGuardianAccount(null, { kernelAddress: K(1), label: "nabil", addedAt: 5 });
  assert.equal(r.kind, "written");
  if (r.kind === "written") assert.equal(isGuardianAccountIndex(r.index), true);
  assert.equal(isGuardianAccountIndex(emptyGuardianAccountIndex()), true);
  assert.equal(isGuardianAccountIndex({ format: "woco.like.v1", accounts: [] }), false);
  assert.equal(isGuardianAccountIndex({ format: GUARDIAN_ACCOUNT_INDEX_FORMAT, accounts: [{ kernelAddress: "nope", addedAt: 1 }] }), false);
  assert.equal(isGuardianAccountIndex({ format: GUARDIAN_ACCOUNT_INDEX_FORMAT, accounts: [{ kernelAddress: K(1), addedAt: -1 }] }), false);
  assert.equal(isGuardianAccountIndex({ format: GUARDIAN_ACCOUNT_INDEX_FORMAT, accounts: [{ kernelAddress: K(1), label: "Has Space", addedAt: 1 }] }), false);
  assert.equal(isGuardianAccountIndex({ v: 2, ciphertext: "…" }), false); // a sealed envelope is not an index
  assert.equal(isGuardianAccountIndex(null), false);
});

test("upsert: a new account is appended; the same account again is unchanged (no stamped write)", () => {
  const a = upsertGuardianAccount(null, { kernelAddress: K(1), addedAt: 10 });
  assert.equal(a.kind, "written");
  const idx = a.kind === "written" ? a.index : emptyGuardianAccountIndex();
  const b = upsertGuardianAccount(idx, { kernelAddress: K(1).toUpperCase().replace("0X", "0x"), addedAt: 99 });
  assert.equal(b.kind, "unchanged");
  const c = upsertGuardianAccount(idx, { kernelAddress: K(2), addedAt: 20 });
  assert.equal(c.kind, "written");
  if (c.kind === "written") assert.deepEqual(c.index.accounts.map((x) => x.kernelAddress), [K(1), K(2)]);
});

test("upsert: a new label rewrites the entry but keeps the ORIGINAL addedAt", () => {
  const a = upsertGuardianAccount(null, { kernelAddress: K(1), addedAt: 10 });
  const idx = a.kind === "written" ? a.index : emptyGuardianAccountIndex();
  const b = upsertGuardianAccount(idx, { kernelAddress: K(1), label: "Nabil", addedAt: 500 });
  assert.equal(b.kind, "written");
  if (b.kind === "written") assert.deepEqual(b.index.accounts, [{ kernelAddress: K(1), addedAt: 10, label: "nabil" }]);
});

test("upsert refuses garbage and a full index", () => {
  assert.equal(upsertGuardianAccount(null, { kernelAddress: "0x12", addedAt: 1 }).kind, "refused");
  assert.equal(upsertGuardianAccount(null, { kernelAddress: K(1), label: "bad label", addedAt: 1 }).kind, "refused");
  assert.equal(upsertGuardianAccount(null, { kernelAddress: K(1), addedAt: NaN }).kind, "refused");
  let idx = emptyGuardianAccountIndex();
  for (let i = 1; i <= MAX_GUARDIAN_INDEX_ACCOUNTS; i++) {
    const r = upsertGuardianAccount(idx, { kernelAddress: K(i), addedAt: i });
    assert.equal(r.kind, "written");
    if (r.kind === "written") idx = r.index;
  }
  assert.equal(upsertGuardianAccount(idx, { kernelAddress: K(999), addedAt: 1 }).kind, "refused");
  // …but an existing account can still be refreshed.
  assert.equal(upsertGuardianAccount(idx, { kernelAddress: K(3), label: "x", addedAt: 1 }).kind, "written");
});

test("candidates come oldest first, case-folded and de-duplicated", () => {
  const ordered = orderGuardianCandidates({
    format: GUARDIAN_ACCOUNT_INDEX_FORMAT,
    accounts: [
      { kernelAddress: K(2), addedAt: 20 },
      { kernelAddress: K(1).toUpperCase().replace("0X", "0x"), addedAt: 10 },
      { kernelAddress: K(1), addedAt: 30 },
      { kernelAddress: K(3), addedAt: 5 },
    ],
  });
  assert.deepEqual(ordered.map((c) => c.kernelAddress), [K(3), K(1), K(2)]);
});
