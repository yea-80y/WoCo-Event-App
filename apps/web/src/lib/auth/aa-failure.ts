/**
 * Is a thrown error an ERC-4337 (account-abstraction) failure — the bundler,
 * the paymaster or the EntryPoint refusing — rather than the user's own?
 *
 * It answers ONE question for the recovery screens (`recovery-errors.ts`):
 * whether to replace the bundler's own words with "temporarily unavailable".
 * Installing a guardian and rotating an owner are the only two things a WoCo
 * account still does through ZeroDev, and the sponsorship plan has a hard
 * monthly cap; past it, every userOp is refused with text that reads to a user
 * like their account is broken.
 *
 * It used to live in `sub-ens-permit.ts` beside the gasless mint rail's sponsor
 * fallback. That rail is gone (#501 — every sub-ENS mint is a sponsor mint);
 * this classifier is not, so it moved to a module that names what it does.
 */

/**
 * An ERC-4337 EntryPoint failure code: AA10–AA95, always two digits, matched
 * against the RAW message so case is meaningful.
 *
 * The bare two-letter form used to sit in the needle list below, lowercased and
 * substring-matched — which any message carrying a tx hash or an address hits by
 * chance ("execution reverted: 0x8aa3…aa91"). That classified failures which
 * have nothing to do with account abstraction as a platform problem, and told
 * the user to try again later over an error only they could fix.
 */
const AA_CODE = /\bAA\d{2}\b/;

export function isAccountAbstractionFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (AA_CODE.test(msg)) return true;
  return [
    "User Operation",
    "UserOperation",
    "verificationGasLimit",
    "paymaster",
    "bundler",
    "sponsorUserOperation",
    "signature error",
  ].some((needle) => msg.toLowerCase().includes(needle.toLowerCase()));
}
