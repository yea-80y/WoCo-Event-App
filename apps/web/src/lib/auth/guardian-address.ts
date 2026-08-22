/**
 * The guardian account's address, derived WITHOUT the SDK and WITHOUT the chain
 * (#161).
 *
 * The guardian account is a Kernel v3.1 whose root validator is ZeroDev's
 * WeightedECDSAValidator, deployed by the KernelFactory through CREATE2. Its
 * address is therefore a pure function of (factory, implementation, validator
 * singleton, validator enable data, index) — all fixed constants plus the
 * `GuardianConfig`. The SDK computes the same thing by asking the EntryPoint to
 * simulate the deployment (`getSenderAddress`, an RPC round trip); this module
 * replays the arithmetic locally, from Kernel's own source:
 *
 *   KernelFactory.createAccount(data, salt):
 *       LibClone.createDeterministicERC1967(impl, keccak256(data ‖ salt))
 *   data = Kernel.initialize(bytes21 rootValidator, address hook,
 *                            bytes validatorData, bytes hookData, bytes[] initConfig)
 *   rootValidator = 0x01 ‖ validator          (VALIDATOR_TYPE.SECONDARY)
 *   validatorData = abi.encode(address[] guardians, uint24[] weights,
 *                              uint24 threshold, uint48 delay)   — signers sorted
 *                              by address DESCENDING, delay 0
 *   salt          = bytes32(index) = 0
 *
 * WHY TWO DERIVATIONS. Setup pins this address in the caller hook; recovery must
 * rebuild the guardian account at the SAME address to call `doRecovery`. The
 * issue (#161) is that the SDK path is resolved from `@zerodev/*` internals at
 * call time, so a dependency bump that moves the factory, the validator singleton
 * or the enable-data encoding would change every derived address and strand every
 * installed backup, silently. With an independent derivation:
 *  - `test/guardian-address.test.ts` pins THIS function to values observed from
 *    the chain (the EntryPoint's own answer on Arb Sepolia), and pins the SDK's
 *    constants + enable-data encoding to the ones inlined here — a lockfile drift
 *    turns CI red instead of breaking recovery in production;
 *  - `kernel-account.ts` cross-checks the SDK-built account against this value at
 *    the two committing moments (before the install userOp, before the recovery
 *    userOp) and refuses on disagreement with nothing irreversible done.
 *
 * Pure, synchronous, no I/O. Constants are Arb Sepolia / Kernel v3.1 (the only
 * chain and version this layer supports — see `KERNEL_CHAIN_ID`).
 */
import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  keccak256,
  parseAbi,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { assertGuardianConfig, type GuardianConfig } from "./guardian-config.js";

/** Kernel v3.1 account implementation (`KernelVersionToAddressesMap["0.3.1"]`). */
export const KERNEL_V3_1_IMPLEMENTATION = "0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D" as const;
/** KernelFactory for v3.1 — the CREATE2 deployer (`from` in the address formula). */
export const KERNEL_V3_1_FACTORY = "0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419" as const;
/** WeightedECDSAValidator singleton for Kernel 0.3.0/0.3.1 (`kernelVersionRangeToValidator`). */
export const WEIGHTED_ECDSA_VALIDATOR_V3_1 = "0xeD89244160CfE273800B58b1B534031699dFeEEE" as const;
/** `VALIDATOR_TYPE.SECONDARY` — the type byte prefixed to a validator address in a ValidationId. */
const VALIDATOR_TYPE_SECONDARY = "0x01" as const;
/** Account index — the SDK default; WoCo never passes another. */
const GUARDIAN_ACCOUNT_INDEX = 0n;

/**
 * `keccak256(ERC-1967 minimal-proxy init code for the implementation)` — what
 * `LibClone.createDeterministicERC1967` hashes. The byte layout is viem-independent
 * and identical to the SDK's `initCodeHashV0_7`.
 */
export function kernelV3InitCodeHash(implementation: Address = KERNEL_V3_1_IMPLEMENTATION): Hex {
  return keccak256(
    concatHex([
      "0x603d3d8160223d3973",
      implementation,
      "0x6009",
      "0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076",
      "0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3",
    ]),
  );
}

/** The SDK sorts signers by address DESCENDING before encoding; the address depends on it. */
function sortSignersDescending(config: GuardianConfig): GuardianConfig["signers"] {
  return [...config.signers].sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? 1 : -1));
}

/**
 * WeightedECDSAValidator enable data — `(address[] _guardians, uint24[] _weights,
 * uint24 _threshold, uint48 _delay)` with delay 0 (the SDK's `getEnableData`).
 */
export function weightedEnableData(config: GuardianConfig): Hex {
  assertGuardianConfig(config);
  const sorted = sortSignersDescending(config);
  return encodeAbiParameters(
    [
      { name: "_guardians", type: "address[]" },
      { name: "_weights", type: "uint24[]" },
      { name: "_threshold", type: "uint24" },
      { name: "_delay", type: "uint48" },
    ],
    [sorted.map((s) => s.address), sorted.map((s) => s.weight), config.threshold, 0],
  );
}

const KERNEL_V3_1_INITIALIZE_ABI = parseAbi([
  "function initialize(bytes21 _rootValidator, address hook, bytes validatorData, bytes hookData, bytes[] initConfig)",
]);

/**
 * `Kernel.initialize(...)` calldata for a guardian account: weighted validator as
 * root (SECONDARY type), no hook, no init config — exactly what
 * `createKernelAccount({ plugins: { sudo: weightedValidator } })` composes.
 */
export function guardianInitData(config: GuardianConfig): Hex {
  return encodeFunctionData({
    abi: KERNEL_V3_1_INITIALIZE_ABI,
    functionName: "initialize",
    args: [
      concatHex([VALIDATOR_TYPE_SECONDARY, WEIGHTED_ECDSA_VALIDATOR_V3_1]),
      zeroAddress,
      weightedEnableData(config),
      "0x",
      [],
    ],
  });
}

/**
 * The guardian account's address for `config` — lowercased. This is the value the
 * caller hook pins and the address `recoverAccount` must rebuild the guardian at.
 */
export function guardianAddressFor(config: GuardianConfig): string {
  const salt = keccak256(concatHex([guardianInitData(config), toHex(GUARDIAN_ACCOUNT_INDEX, { size: 32 })]));
  return getContractAddress({
    bytecodeHash: kernelV3InitCodeHash(),
    opcode: "CREATE2",
    from: KERNEL_V3_1_FACTORY,
    salt,
  }).toLowerCase();
}

/**
 * Thrown when the SDK-built guardian account does not sit at the address this
 * module derives — the #161 drift, caught before anything is sent.
 */
export class GuardianDerivationDriftError extends Error {
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super(
      "This version of the app derives the recovery guardian differently from the one installed " +
        `(expected ${expected}, got ${actual}). Nothing was changed. Update the app and try again.`,
    );
    this.name = "GuardianDerivationDriftError";
    this.expected = expected;
    this.actual = actual;
  }
}

/** Assert the SDK-built account address agrees with the pure derivation. */
export function assertGuardianAddressAgrees(config: GuardianConfig, sdkAddress: string): string {
  const expected = guardianAddressFor(config);
  const actual = sdkAddress.toLowerCase();
  if (actual !== expected) throw new GuardianDerivationDriftError(expected, actual);
  return expected;
}
