/**
 * The guardian SET behind a recovery backup — the ONE place its shape is written
 * (#161). Four call sites used to hand-write
 * `{ signers: [{ address, weight: 100 }], threshold: 100 }` independently; the
 * guardian account's on-chain address is a pure function of this object, so any
 * two sites disagreeing by a single field would pin one address at setup and
 * derive another at recovery — discovered only by a locked-out user.
 *
 * Deliberately dependency-free: it is imported eagerly by the auth store, and the
 * derivation that needs viem lives in `guardian-address.ts` (lazy-loaded).
 */

/**
 * Guardian set for the weighted-ECDSA guardian ACCOUNT (a Kernel whose sudo
 * validator is ZeroDev's WeightedECDSAValidator). v1 = a single backup EOA (one
 * signer, weight 100, threshold 100). Social recovery = more signers + an M-of-N
 * threshold — SAME shape, no rewrite.
 */
export interface GuardianConfig {
  signers: { address: `0x${string}`; weight: number }[];
  threshold: number;
}

/** Weight and threshold are `uint24` on-chain (WeightedECDSAValidator enable data). */
const UINT24_MAX = 0xffffff;

export function isEthAddress(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * The v1 guardian set for ONE backup wallet: that wallet alone, at full weight,
 * threshold met by it alone. Every setup, pre-flight and recovery path derives the
 * guardian address from THIS object and nothing else.
 */
export function guardianConfigForBackup(backupAddress: string): GuardianConfig {
  if (!isEthAddress(backupAddress)) {
    throw new Error(`guardianConfigForBackup: not an address: ${String(backupAddress)}`);
  }
  return { signers: [{ address: backupAddress, weight: 100 }], threshold: 100 };
}

/**
 * Structural validity, mirroring what the on-chain validator and the SDK accept:
 * at least one signer, every signer a distinct address with a uint24 weight, a
 * positive uint24 threshold the weights can meet. Throws with the reason.
 */
export function assertGuardianConfig(config: GuardianConfig): void {
  if (!config.signers.length) throw new Error("guardian config: no signers");
  if (!Number.isInteger(config.threshold) || config.threshold <= 0 || config.threshold > UINT24_MAX) {
    throw new Error(`guardian config: bad threshold ${config.threshold}`);
  }
  const seen = new Set<string>();
  let sum = 0;
  for (const s of config.signers) {
    if (!isEthAddress(s.address)) throw new Error(`guardian config: bad signer address ${String(s.address)}`);
    const lc = s.address.toLowerCase();
    if (seen.has(lc)) throw new Error(`guardian config: duplicate signer ${lc}`);
    seen.add(lc);
    if (!Number.isInteger(s.weight) || s.weight <= 0 || s.weight > UINT24_MAX) {
      throw new Error(`guardian config: bad weight ${s.weight} for ${lc}`);
    }
    sum += s.weight;
  }
  if (sum < config.threshold) {
    throw new Error(`guardian config: weights sum ${sum} below threshold ${config.threshold}`);
  }
}
