/**
 * Guardian-address derivation locks (#161).
 *
 * Setup pins the guardian account's address in the caller hook; recovery must
 * rebuild the guardian at the SAME address or `doRecovery` reverts "not allowed"
 * — discovered by a locked-out user. The address is a pure function of pinned
 * constants + the GuardianConfig, computed two ways:
 *  - `guardianAddressFor` (ours, SDK-free) — pinned HERE to values the chain
 *    itself produced: each expected address below is the EntryPoint's answer to
 *    `getSenderAddress` for that config on Arbitrum Sepolia (SDK path, 2026-08-22,
 *    `@zerodev/sdk` + `@zerodev/weighted-ecdsa-validator` as in package-lock);
 *  - the SDK's (`createKernelAccount` + `createWeightedECDSAValidator`) — whose
 *    inputs are pinned here too: the Kernel 0.3.1 addresses it ships, the
 *    weighted-validator singleton it resolves, and the enable-data bytes it
 *    encodes for a given config, all compared against the constants and encoder
 *    inlined in `guardian-address.ts`.
 *
 * So a lockfile bump that moves any of those — factory, implementation, validator
 * singleton, encoding, sort order — turns CI red instead of silently changing
 * every derived guardian address. Offline: the only "client" is a transport that
 * answers `eth_chainId` and refuses everything else.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, custom } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { constants as sdkConstants, addressToEmptyAccount } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { createWeightedECDSAValidator, getValidatorAddress } from "@zerodev/weighted-ecdsa-validator";
import {
  GuardianDerivationDriftError,
  KERNEL_V3_1_FACTORY,
  KERNEL_V3_1_IMPLEMENTATION,
  WEIGHTED_ECDSA_VALIDATOR_V3_1,
  assertGuardianAddressAgrees,
  guardianAddressFor,
  kernelV3InitCodeHash,
  weightedEnableData,
} from "../src/lib/auth/guardian-address.js";
import {
  assertGuardianConfig,
  guardianConfigForBackup,
  type GuardianConfig,
} from "../src/lib/auth/guardian-config.js";

const A1 = "0x1111111111111111111111111111111111111111" as const;
const A2 = "0x2222222222222222222222222222222222222222" as const;
const A3 = "0x3333333333333333333333333333333333333333" as const;
const DEPLOYER = "0xff9758533Ec0FE75030820Af9468989B53b19a5c" as const;

/** Chain-observed (EntryPoint `getSenderAddress`, Arb Sepolia) — see header. */
const OBSERVED = {
  [A1]: "0x949b83903aced5939b28612d4ee828af33d732d1",
  [A2]: "0x60f71ff84c83d74c32abd268339e9b31bca444e5",
  [DEPLOYER]: "0xf663af23bbd4827afec67c034e4860dfed3ddbfa",
} as const;
const TWO_OF_THREE: GuardianConfig = {
  signers: [
    { address: A1, weight: 50 },
    { address: A3, weight: 50 },
    { address: A2, weight: 50 },
  ],
  threshold: 100,
};
const TWO_OF_THREE_OBSERVED = "0x3ff6c00588f542ce168bdb73f7c424b5a02b1fe4";

test("v1 guardian config is one signer at full weight, threshold met by it alone", () => {
  assert.deepEqual(guardianConfigForBackup(A1), {
    signers: [{ address: A1, weight: 100 }],
    threshold: 100,
  });
  assert.throws(() => guardianConfigForBackup("not-an-address"), /not an address/);
  assert.throws(() => guardianConfigForBackup(A1.slice(0, 41)), /not an address/);
});

test("guardian config validation mirrors what the validator accepts", () => {
  assert.doesNotThrow(() => assertGuardianConfig(TWO_OF_THREE));
  assert.throws(() => assertGuardianConfig({ signers: [], threshold: 1 }), /no signers/);
  assert.throws(
    () => assertGuardianConfig({ signers: [{ address: A1, weight: 10 }], threshold: 11 }),
    /below threshold/,
  );
  assert.throws(
    () => assertGuardianConfig({ signers: [{ address: A1, weight: 50 }, { address: A1, weight: 50 }], threshold: 100 }),
    /duplicate/,
  );
  assert.throws(
    () => assertGuardianConfig({ signers: [{ address: A1, weight: 0 }], threshold: 0 }),
    /bad threshold/,
  );
  assert.throws(
    () => assertGuardianConfig({ signers: [{ address: A1, weight: 0x1000000 }], threshold: 1 }),
    /bad weight/,
  );
});

test("pure derivation reproduces the chain-observed guardian address (1-of-1)", () => {
  for (const [backup, expected] of Object.entries(OBSERVED)) {
    assert.equal(guardianAddressFor(guardianConfigForBackup(backup)), expected, backup);
  }
});

test("pure derivation reproduces the chain-observed address for a 2-of-3 set (sort order locked)", () => {
  assert.equal(guardianAddressFor(TWO_OF_THREE), TWO_OF_THREE_OBSERVED);
  // Same set, different input order — same address. The encoder sorts; callers need not.
  const shuffled: GuardianConfig = { ...TWO_OF_THREE, signers: [...TWO_OF_THREE.signers].reverse() };
  assert.equal(guardianAddressFor(shuffled), TWO_OF_THREE_OBSERVED);
});

test("address case does not change the derivation (bytes, not strings, are hashed)", () => {
  assert.equal(
    guardianAddressFor(guardianConfigForBackup(DEPLOYER)),
    guardianAddressFor(guardianConfigForBackup(DEPLOYER.toLowerCase())),
  );
});

test("the SDK still ships the Kernel 0.3.1 addresses the pure derivation inlines", () => {
  const shipped = sdkConstants.KernelVersionToAddressesMap["0.3.1"];
  assert.equal(shipped.factoryAddress.toLowerCase(), KERNEL_V3_1_FACTORY.toLowerCase());
  assert.equal(shipped.accountImplementationAddress.toLowerCase(), KERNEL_V3_1_IMPLEMENTATION.toLowerCase());
  // The SDK's own initCodeHash constant is what `getKernelAddressFromECDSA` uses
  // when no client is given — our replay of the ERC-1967 proxy init code must
  // hash to the same value.
  assert.equal(shipped.initCodeHash?.toLowerCase(), kernelV3InitCodeHash().toLowerCase());
  // KERNEL_V3_1 is the version string this whole layer is fixed to.
  assert.equal(KERNEL_V3_1, "0.3.1");
});

test("the SDK still resolves the weighted-validator singleton the pure derivation inlines", () => {
  assert.equal(
    getValidatorAddress(getEntryPoint("0.7"), KERNEL_V3_1).toLowerCase(),
    WEIGHTED_ECDSA_VALIDATOR_V3_1.toLowerCase(),
  );
});

/** Offline viem client: answers the chain id the SDK asks for at plugin creation, refuses all else. */
function offlineClient() {
  return createPublicClient({
    chain: arbitrumSepolia,
    transport: custom({
      request: async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return "0x66eee"; // 421614
        throw new Error(`offline test client refused ${method}`);
      },
    }),
  });
}

test("the SDK still encodes weighted enable data exactly as the pure derivation does", async () => {
  for (const config of [guardianConfigForBackup(A1), guardianConfigForBackup(DEPLOYER), TWO_OF_THREE]) {
    const validator = await createWeightedECDSAValidator(offlineClient(), {
      entryPoint: getEntryPoint("0.7"),
      kernelVersion: KERNEL_V3_1,
      config: { threshold: config.threshold, signers: config.signers },
      signers: config.signers.map((s) => addressToEmptyAccount(s.address)),
    });
    assert.equal((await validator.getEnableData()).toLowerCase(), weightedEnableData(config).toLowerCase());
    // Root-validator identity the init data carries: SECONDARY type + this singleton.
    assert.equal(validator.validatorType, "SECONDARY");
    assert.equal(validator.getIdentifier().toLowerCase(), WEIGHTED_ECDSA_VALIDATOR_V3_1.toLowerCase());
  }
});

test("assertGuardianAddressAgrees accepts the derived address in any case and refuses any other", () => {
  const config = guardianConfigForBackup(A1);
  assert.equal(assertGuardianAddressAgrees(config, OBSERVED[A1].toUpperCase().replace("0X", "0x")), OBSERVED[A1]);
  assert.throws(
    () => assertGuardianAddressAgrees(config, OBSERVED[A2]),
    (e: unknown) =>
      e instanceof GuardianDerivationDriftError && e.expected === OBSERVED[A1] && e.actual === OBSERVED[A2],
  );
});
