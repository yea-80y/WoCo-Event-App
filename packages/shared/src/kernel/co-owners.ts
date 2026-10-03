/**
 * Every passkey a co-owner (#746, Fable consult 9): an account starts with one
 * passkey on ZeroDev's ECDSAValidator as its Kernel root, and the first time a
 * second passkey is added it moves to ZeroDev's WeightedECDSAValidator - one
 * signer per passkey, weight 1, threshold 1, no delay - so any one passkey signs
 * alone and nothing ever moves between devices.
 *
 * Plain data (no viem), so the app that builds these calls, the server that
 * authorises sessions from the signer list (lib/auth/kernel-owner.ts) and the
 * sponsorship policy (lib/zerodev/sponsor-policy.ts) read the SAME bytes.
 *
 * Facts pinned against the bytecode deployed on Arbitrum One by
 * WoCo-Contracts test/WeightedRootKernel.t.sol:
 *  - the switch must be ONE batch [changeRootValidator(weighted), uninstallValidation(ECDSA)]:
 *    the switch alone leaves the ECDSA validation installed, and the first passkey would keep an
 *    ERC-1271 path that removing it from the list cannot close (F6);
 *  - the validator ACCEPTS an empty list, or a threshold above the total weight, and the account
 *    is then locked for good (F5) - so every list goes through {@link isValidCoOwnerList}.
 */

/** ZeroDev ECDSAValidator for Kernel 0.3.x - the root every account starts on. */
export const ECDSA_VALIDATOR_V3_1 = "0x845ADb2C711129d4f3966735eD98a9F09fC4cE57" as const;

/** ZeroDev WeightedECDSAValidator for Kernel 0.3.0/0.3.1 (`kernelVersionRangeToValidator`). */
export const WEIGHTED_ECDSA_VALIDATOR_V3_1 = "0xeD89244160CfE273800B58b1B534031699dFeEEE" as const;

/** Kernel ValidationId: type byte 0x01 (validator) || validator address. What `rootValidator()` returns. */
export const ECDSA_ROOT_ID = "0x01845adb2c711129d4f3966735ed98a9f09fc4ce57" as const;
export const WEIGHTED_ROOT_ID = "0x01ed89244160cfe273800b58b1b534031699dfeeee" as const;

/** One passkey per signer; the sponsorship policy refuses longer lists. */
export const MAX_CO_OWNERS = 10;

export const KERNEL_ROOT_VALIDATOR_ABI = [
  {
    type: "function",
    name: "rootValidator",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes21" }],
  },
] as const;

export const WEIGHTED_GUARDIAN_ABI = [
  {
    type: "function",
    name: "guardian",
    stateMutability: "view",
    inputs: [
      { name: "guardian", type: "address" },
      { name: "kernel", type: "address" },
    ],
    outputs: [
      { name: "weight", type: "uint24" },
      { name: "nextGuardian", type: "address" },
    ],
  },
] as const;

export const WEIGHTED_RENEW_FN = "function renew(address[] _guardians, uint24[] _weights, uint24 _threshold, uint48 _delay)";
export const CHANGE_ROOT_VALIDATOR_FN =
  "function changeRootValidator(bytes21 _rootValidator, address hook, bytes validatorData, bytes hookData)";
export const UNINSTALL_VALIDATION_FN = "function uninstallValidation(bytes21 vId, bytes deinitData, bytes hookDeinitData)";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
/** The validator's linked-list sentinel - never a signer. */
const SENTINEL = "0xffffffffffffffffffffffffffffffffffffffff";

/**
 * A list the account may hold: 1..MAX_CO_OWNERS distinct real addresses. Pure.
 * Anything else either locks the account (empty) or is refused by the validator.
 */
export function isValidCoOwnerList(signers: readonly string[]): boolean {
  if (signers.length < 1 || signers.length > MAX_CO_OWNERS) return false;
  const seen = new Set<string>();
  for (const s of signers) {
    if (typeof s !== "string" || !ADDRESS.test(s)) return false;
    const lower = s.toLowerCase();
    if (lower === ZERO || lower === SENTINEL || seen.has(lower)) return false;
    seen.add(lower);
  }
  return true;
}

/** Signers in the order the ZeroDev plugin writes them: lowercase, descending. Pure. */
export function sortCoOwners(signers: readonly string[]): string[] {
  return signers.map((s) => s.toLowerCase()).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}
