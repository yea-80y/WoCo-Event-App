import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getRegistrarAddress, getSubEnsChainId } from "../src/lib/chain/sub-ens-contract.js";

// A scoped ZeroDev session key may call exactly ONE address: the registrar
// hardcoded in the frontend. The permit it carries is signed by the server for
// whatever getRegistrarAddress() resolves, and the registrar's EIP-712 domain
// binds its own address — so if the two files disagree, every Kernel mint is
// refused and the name is simply unmintable on the gasless path until a human
// notices. #440 moved the pair once (2026-09-02); nothing else in the suite
// would catch a later move that updates one file and forgets the other.
//
// STOPGAP. Scraping another workspace's source is not how this should be
// guarded — the per-chain address map belongs in packages/shared, imported by
// both sides so the compiler is the check. Retire this test when that lands.
const KERNEL_ACCOUNT = fileURLToPath(
  new URL("../../web/src/lib/auth/kernel-account.ts", import.meta.url),
);

test("the frontend session-key target is the registrar the server signs permits for", () => {
  // The defaults are what production runs on unless env overrides BOTH sides,
  // and env cannot reach the frontend constant at all.
  delete process.env.SUB_ENS_REGISTRAR_ADDRESS;
  delete process.env.SUB_ENS_CHAIN_ID;

  const src = readFileSync(KERNEL_ACCOUNT, "utf8");
  const frontend = /export const WOCO_REGISTRAR_ADDRESS\s*=\s*"(0x[0-9a-fA-F]{40})"/.exec(src)?.[1];
  const kernelChain = /export const KERNEL_CHAIN_ID\s*=\s*(\d+)/.exec(src)?.[1];
  assert.ok(frontend, "WOCO_REGISTRAR_ADDRESS not found in kernel-account.ts");
  assert.ok(kernelChain, "KERNEL_CHAIN_ID not found in kernel-account.ts");

  assert.equal(
    Number(kernelChain),
    getSubEnsChainId(),
    "the frontend Kernel chain and the server's sub-ENS chain have diverged",
  );
  assert.equal(
    getRegistrarAddress(Number(kernelChain)).toLowerCase(),
    frontend.toLowerCase(),
    "kernel-account.ts WOCO_REGISTRAR_ADDRESS != the server's registrar default",
  );
});
