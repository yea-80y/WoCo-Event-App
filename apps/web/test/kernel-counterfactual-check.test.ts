/**
 * First login checks the Kernel address it is handed (#186, Pass B M13).
 *
 * The ZeroDev SDK learns a new account's address from an RPC's `getSenderAddress`
 * revert, and on first login that answer is stored as the user's permanent
 * identity. The check recomputes it with CREATE2 - no chain involved - and refuses
 * a mismatch. Behaviour below for the computation; source pins for the call site,
 * which loads viem + the ZeroDev SDK and so cannot run in this suite (the same
 * device as `recovery-pinned-read.test.ts`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicClient, custom } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { getKernelAddressFromECDSA } from "@zerodev/ecdsa-validator";
import { KERNEL_CHAIN } from "../src/lib/auth/kernel-account.js";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/** Refuses every request: anything it is asked proves the computation trusted a network. */
const asked: string[] = [];
const refusingClient = createPublicClient({
  chain: KERNEL_CHAIN,
  transport: custom({
    request: async ({ method }: { method: string }) => {
      asked.push(method);
      throw new Error(`refused ${method}`);
    },
  }),
});

const counterfactual = (eoa: `0x${string}`) =>
  getKernelAddressFromECDSA({
    entryPoint: getEntryPoint("0.7"),
    kernelVersion: KERNEL_V3_1,
    eoaAddress: eoa,
    index: 0n,
    publicClient: refusingClient,
  });

test("the expected address is computed with no network at all", async () => {
  const a = privateKeyToAccount(("0x" + "11".repeat(32)) as `0x${string}`).address;
  const b = privateKeyToAccount(("0x" + "22".repeat(32)) as `0x${string}`).address;
  const first = await counterfactual(a);
  assert.match(first, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(await counterfactual(a), first, "deterministic per key");
  assert.notEqual(await counterfactual(b), first, "and distinct between keys");
  assert.deepEqual(asked, [], "no RPC was consulted");
});

test("the client computes it exactly as the server authorizes sessions", () => {
  const params = /getKernelAddressFromECDSA\(\{\s*entryPoint[^}]*index: 0n,/;
  const client = read("../src/lib/auth/kernel-account.ts");
  const fn = client.slice(client.indexOf("export async function counterfactualKernelOf("));
  assert.match(fn.slice(0, 900), /getEntryPoint\("0\.7"\)[\s\S]*KERNEL_V3_1[\s\S]*index: 0n,/);
  assert.match(read("../../server/src/lib/auth/kernel-owner.ts"), params);
});

test("every build without an override is checked against it, and a mismatch refuses", () => {
  const src = read("../src/lib/auth/kernel-account.ts");
  const start = src.indexOf("export async function buildKernelFromPrivateKey(");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  const check = body.indexOf(
    "if (!opts?.address && (await counterfactualKernelOf(signer.address)) !== account.address.toLowerCase()) {",
  );
  assert.ok(check > 0, "the check is in the build");
  assert.ok(check > body.indexOf("await createKernelAccount("), "it checks the address the SDK produced");
  assert.ok(check < body.indexOf("return {"), "before the account is handed back");
  assert.match(body.slice(check, check + 250), /throw new Error\(/);
});
