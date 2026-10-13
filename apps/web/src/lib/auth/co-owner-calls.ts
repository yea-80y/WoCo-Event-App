/**
 * The two calls that make every passkey a co-owner (#746, Fable consult 9), and the
 * list arithmetic around them. Pure: the viem encoders are passed in, so this module
 * carries no SDK and the server's sponsorship tests classify exactly these bytes
 * (apps/server/test/zerodev-policy.test.ts).
 *
 *  - the SWITCH, sent once, when a one-passkey account adds its second: one batch of
 *    [changeRootValidator(weighted, no hook, list), uninstallValidation(ECDSA)]. The
 *    uninstall is not optional - without it the first passkey keeps an ERC-1271 path
 *    that taking it off the list cannot close (WoCo-Contracts WeightedRootKernel.t.sol F6);
 *  - RENEW, every change after that: the whole new list.
 *
 * Every list is 1..10 distinct keys, sorted as the validator stores them, weight 1,
 * threshold 1, no delay: the validator accepts an empty list or an unreachable
 * threshold and the account is then locked for good (F5).
 */

import {
  CHANGE_ROOT_VALIDATOR_FN,
  ECDSA_ROOT_ID,
  MAX_CO_OWNERS,
  UNINSTALL_VALIDATION_FN,
  WEIGHTED_ECDSA_VALIDATOR_V3_1,
  WEIGHTED_RENEW_FN,
  WEIGHTED_ROOT_ID,
  isValidCoOwnerList,
  sortCoOwners,
} from "@woco/shared/kernel/co-owners";
import { KEY_RING_ANCHOR_ABI, KEY_RING_ANCHOR_ADDRESS, ringRefToAnchor } from "@woco/shared/keyring/anchor";

const NO_RING = `0x${"0".repeat(64)}`;

type Hex = `0x${string}`;

/** The slice of viem these builders use. */
export interface CoOwnerEncoders {
  encodeFunctionData: (args: { abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) => Hex;
  encodeAbiParameters: (params: readonly unknown[], values: readonly unknown[]) => Hex;
  parseAbi: (signatures: readonly string[]) => readonly unknown[];
  parseAbiParameters: (params: string) => readonly unknown[];
}

export interface CoOwnerCall {
  to: Hex;
  data: Hex;
  value: bigint;
}

export class CoOwnerListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoOwnerListError";
  }
}

export const LAST_PASSKEY_MESSAGE = "This is the only passkey on the account. Add another before removing it.";
export const TOO_MANY_PASSKEYS_MESSAGE = `This account already has ${MAX_CO_OWNERS} passkeys. Remove one first.`;

/** The list with `key` added. Throws, in words, when it could not be held. */
export function listWith(current: readonly string[], key: string): string[] {
  const k = key.toLowerCase();
  const next = current.map((s) => s.toLowerCase());
  if (!next.includes(k)) next.push(k);
  if (next.length > MAX_CO_OWNERS) throw new CoOwnerListError(TOO_MANY_PASSKEYS_MESSAGE);
  if (!isValidCoOwnerList(next)) throw new CoOwnerListError("That passkey can't be added to this account.");
  return sortCoOwners(next);
}

/** The list with `key` taken off. Throws when nothing would be left. */
export function listWithout(current: readonly string[], key: string): string[] {
  const k = key.toLowerCase();
  const next = current.map((s) => s.toLowerCase()).filter((s) => s !== k);
  if (next.length === 0) throw new CoOwnerListError(LAST_PASSKEY_MESSAGE);
  if (!isValidCoOwnerList(next)) throw new CoOwnerListError("That passkey can't be removed from this account.");
  return sortCoOwners(next);
}

function enableData(d: CoOwnerEncoders, signers: readonly string[]): Hex {
  const sorted = sortCoOwners(signers);
  if (!isValidCoOwnerList(sorted)) throw new CoOwnerListError("That list of passkeys can't be held.");
  return d.encodeAbiParameters(d.parseAbiParameters("address[], uint24[], uint24, uint48"), [
    sorted,
    sorted.map(() => 1),
    1,
    0,
  ]);
}

/** The switch: [changeRootValidator(weighted, no hook, list, 0x), uninstallValidation(ECDSA)], both on the account. */
export function coOwnerSwitchCalls(d: CoOwnerEncoders, kernel: string, signers: readonly string[]): CoOwnerCall[] {
  const abi = d.parseAbi([CHANGE_ROOT_VALIDATOR_FN, UNINSTALL_VALIDATION_FN]);
  const to = kernel.toLowerCase() as Hex;
  return [
    {
      to,
      value: 0n,
      data: d.encodeFunctionData({
        abi,
        functionName: "changeRootValidator",
        args: [WEIGHTED_ROOT_ID, "0x0000000000000000000000000000000000000000", enableData(d, signers), "0x"],
      }),
    },
    {
      to,
      value: 0n,
      data: d.encodeFunctionData({ abi, functionName: "uninstallValidation", args: [ECDSA_ROOT_ID, "0x", "0x"] }),
    },
  ];
}

/** Renew: the account's whole new list, on the weighted validator. */
export function coOwnerRenewCall(d: CoOwnerEncoders, signers: readonly string[]): CoOwnerCall {
  const sorted = sortCoOwners(signers);
  if (!isValidCoOwnerList(sorted)) throw new CoOwnerListError("That list of passkeys can't be held.");
  return {
    to: WEIGHTED_ECDSA_VALIDATOR_V3_1.toLowerCase() as Hex,
    value: 0n,
    data: d.encodeFunctionData({
      abi: d.parseAbi([WEIGHTED_RENEW_FN]),
      functionName: "renew",
      args: [sorted, sorted.map(() => 1), 1, 0],
    }),
  };
}

/**
 * The key ring rides LAST in the same op (#186): `setRing(prev, next)` on the anchor,
 * so a removal and the keys it takes away land together or not at all, and a stale
 * `prev` (another device moved the ring) reverts the whole batch. `prev` null = the
 * account's first ring.
 */
export function coOwnerRingCall(d: CoOwnerEncoders, prevRef: string | null, nextRef: string): CoOwnerCall {
  const anchor = (ref: string | null) => (ref === null ? NO_RING : ringRefToAnchor(ref)) as Hex;
  return {
    to: KEY_RING_ANCHOR_ADDRESS as Hex,
    value: 0n,
    data: d.encodeFunctionData({
      abi: d.parseAbi([...KEY_RING_ANCHOR_ABI]),
      functionName: "setRing",
      args: [anchor(prevRef), anchor(nextRef)],
    }),
  };
}

/** The chain's answers `readKernelSignerFor` decides on, in one read. */
export interface SignerRead {
  root: "ecdsa" | "weighted" | "none";
  /** ECDSA validator storage (null = none). */
  owner: string | null;
  /** This key's weight on the weighted list. */
  weight: number;
  threshold: number;
}

/** Marker for "co-owned, and this key is not on the list" - never an address. */
export const NOT_ON_LIST = "not-on-list" as const;

/**
 * Who controls the account as THIS key's checks need it. Pure. Co-owned: the key
 * itself when it carries the threshold's weight, NOT_ON_LIST when not. Otherwise the
 * ECDSA owner (null = no owner, i.e. undeployed).
 */
export function signerFromRead(r: SignerRead, eoa: string): string | null {
  if (r.root === "weighted") return r.threshold > 0 && r.weight >= r.threshold ? eoa.toLowerCase() : NOT_ON_LIST;
  return r.owner ? r.owner.toLowerCase() : null;
}
