/**
 * Name→address resolution for the recovery portal's manual fallback (#177).
 *
 * The property pinned: "none" is only ever a DEFINITIVE absence (malformed
 * label, or the registrar answered "available"), because the portal renders it
 * as "no backup found — recovery isn't possible", which tells a recoverable,
 * locked-out user to stop trying. Everything nobody answered — a throw, an
 * error envelope, a registered name whose owner did not come back readable —
 * must surface as "error" instead (the #169 rule, by the name route).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSubEnsWith, type SubEnsCheckResponse } from "../src/lib/api/sub-ens-resolve.js";

const OWNER = "0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd";

const resolveSubEnsAddress = (
  input: string,
  check: (label: string) => Promise<SubEnsCheckResponse>,
) => resolveSubEnsWith(check, input);

test("a registered name resolves to its owner, lowercased, with or without the suffix", async () => {
  const seen: string[] = [];
  const check = async (label: string) => {
    seen.push(label);
    return { ok: true, data: { available: false, owner: OWNER } };
  };
  for (const input of ["Nabil", "nabil.woco.eth"]) {
    const r = await resolveSubEnsAddress(input, check);
    assert.deepEqual(r, { status: "found", address: OWNER.toLowerCase() });
  }
  assert.deepEqual(seen, ["nabil", "nabil"], "suffix and casing are normalised before the lookup");
});

test("definitive absences are 'none': malformed label, or an unregistered name", async () => {
  const r1 = await resolveSubEnsAddress("not a label!", async () => {
    throw new Error("must not be called for a malformed label");
  });
  assert.deepEqual(r1, { status: "none" });

  const r2 = await resolveSubEnsAddress("free-name", async () => ({
    ok: true,
    data: { available: true },
  }));
  assert.deepEqual(r2, { status: "none" });
});

test("a lookup nobody answered is 'error', never 'none' (#177)", async () => {
  // A thrown fetch / non-JSON error page.
  const r1 = await resolveSubEnsAddress("nabil", async () => {
    throw new Error("Unexpected token < in JSON");
  });
  assert.equal(r1.status, "error");

  // An error envelope.
  const r2 = await resolveSubEnsAddress("nabil", async () => ({ ok: false, error: "HTTP 500" }));
  assert.deepEqual(r2, { status: "error", reason: "HTTP 500" });

  // ok with no data — a partial answer, not an absence.
  const r3 = await resolveSubEnsAddress("nabil", async () => ({ ok: true }));
  assert.equal(r3.status, "error");
});

test("a REGISTERED name whose owner did not come back readable is 'error' — it has one on-chain", async () => {
  for (const owner of [undefined, "not-hex", "0x123"]) {
    const r = await resolveSubEnsAddress("nabil", async () => ({
      ok: true,
      data: { available: false, owner },
    }));
    assert.equal(r.status, "error", `owner=${String(owner)} read as ${r.status}`);
  }
});
