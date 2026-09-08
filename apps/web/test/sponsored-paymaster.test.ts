/**
 * #517 — the two-hook ZeroDev sponsorship. The stub must hand viem a paymaster
 * to simulate with and NOTHING about gas (or viem skips the bundler estimate);
 * the final call must re-sponsor over the bundler's estimate plus the margin.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PRE_VERIFICATION_GAS_MARGIN_PERCENT,
  sponsoredPaymasterHooks,
  withPreVerificationGasMargin,
  type SponsorFn,
  type SponsorResult,
} from "../src/lib/auth/sponsored-paymaster.js";

const PM = "0xc99c11AD232a24e1158156b1F46495Cc8069c08f" as const;

/** What zd_sponsorUserOperation answers: paymaster fields AND its own (L1-blind) gas figures. */
function sponsorAnswer(pvg: bigint): SponsorResult {
  return {
    paymaster: PM,
    paymasterData: "0xdeadbeef",
    paymasterVerificationGasLimit: 20958n,
    paymasterPostOpGasLimit: 0n,
    callGasLimit: 9100n,
    verificationGasLimit: 293419n,
    preVerificationGas: pvg,
  };
}

function recordingSponsor(answer: SponsorResult): { sponsor: SponsorFn; calls: Parameters<SponsorFn>[0][] } {
  const calls: Parameters<SponsorFn>[0][] = [];
  const sponsor: SponsorFn = async (args) => {
    calls.push(args);
    // Like the real sponsor: a pre-filled preVerificationGas is kept, otherwise its own figure.
    const pre = args.userOperation.preVerificationGas;
    return { ...answer, preVerificationGas: typeof pre === "bigint" && pre > 0n ? pre : answer.preVerificationGas };
  };
  return { sponsor, calls };
}

const baseOp = { sender: "0x1111111111111111111111111111111111111111", nonce: 0n, callData: "0x" } as never;

test("the stub returns the paymaster and NOT ONE gas figure, and does not consume the policy", async () => {
  const { sponsor, calls } = recordingSponsor(sponsorAnswer(55_571n));
  const hooks = sponsoredPaymasterHooks(sponsor);
  const stub = (await hooks.getPaymasterStubData(baseOp)) as Record<string, unknown>;
  assert.equal(stub.paymaster, PM);
  assert.equal(stub.paymasterData, "0xdeadbeef");
  assert.equal(stub.paymasterVerificationGasLimit, 20958n);
  assert.equal(stub.paymasterPostOpGasLimit, 0n);
  assert.equal(stub.isFinal, false, "viem must still run the final step");
  for (const k of ["preVerificationGas", "callGasLimit", "verificationGasLimit", "maxFeePerGas"]) {
    assert.equal(k in stub, false, `${k} in the stub would silence the bundler estimate`);
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].shouldConsume, false, "a thrown-away sponsorship must not count against the policy");
});

test("the final call re-sponsors over the BUNDLER's estimate plus the margin, and the sponsor keeps it", async () => {
  const { sponsor, calls } = recordingSponsor(sponsorAnswer(55_571n));
  const hooks = sponsoredPaymasterHooks(sponsor);
  const final = await hooks.getPaymasterData({ ...baseOp, preVerificationGas: 78_541n } as never);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userOperation.preVerificationGas, 94_249n, "78,541 + 20% — the measured passing value");
  assert.notEqual(calls[0].shouldConsume, false, "the final sponsorship is the real one");
  assert.equal((final as SponsorResult).preVerificationGas, 94_249n);
  assert.equal(final.paymaster, PM);
});

test("the final call refuses to run without an estimate — the sponsor's own figure must never be sent", async () => {
  const { sponsor, calls } = recordingSponsor(sponsorAnswer(55_571n));
  const hooks = sponsoredPaymasterHooks(sponsor);
  await assert.rejects(hooks.getPaymasterData(baseOp), /preVerificationGas is missing/);
  assert.equal(calls.length, 0, "must not sponsor at all");
});

test("the margin is what the module says it is", () => {
  assert.equal(PRE_VERIFICATION_GAS_MARGIN_PERCENT, 20n);
  assert.equal(withPreVerificationGasMargin(100n), 120n);
  assert.equal(withPreVerificationGasMargin(78_541n), 94_249n);
});

// kernel-account.ts loads viem + the ZeroDev SDK and cannot run under this runner
// (same device as backup-add-stale-read.test.ts): pin the wiring on the source.
test("every kernel client is built on the two-hook sponsorship, none on the single documented hook", () => {
  const src = readFileSync(new URL("../src/lib/auth/kernel-account.ts", import.meta.url), "utf8");
  const clients = src.split("createKernelAccountClient(").length - 1;
  const wired = src.split("sponsoredPaymasterHooks(").length - 1; // the import line has no "("
  assert.ok(clients >= 4, `expected the four kernel clients (three session-key/sudo, one guardian), found ${clients}`);
  assert.equal(wired, clients, "every createKernelAccountClient must be sponsored through sponsoredPaymasterHooks");
  assert.doesNotMatch(src, /getPaymasterData\s*:/, "an inline getPaymasterData is the single-hook #517 defect — only the module may define the hooks");
});
