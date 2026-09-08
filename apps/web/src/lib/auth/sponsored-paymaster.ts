/**
 * ZeroDev sponsorship as TWO paymaster hooks, not the documented one (#517).
 *
 * ZeroDev's docs configure `paymaster: { getPaymasterData }` alone. viem then
 * uses that single function as BOTH its stub step and its final step, and
 * because `zd_sponsorUserOperation` answers with every gas field filled, viem
 * never asks the bundler to estimate — the sponsor's figures go straight to
 * `eth_sendUserOperation`. On Arbitrum One that is fatal: the self-funded
 * sponsorship path returns a `preVerificationGas` that is blind to the L1
 * data-fee component (measured 2026-09-08: 55,571 against the same bundler's
 * own 78,540 for the same op, same second), and the bundler rejects the op.
 * Sepolia never showed it because its L1 component is negligible.
 *
 * So: the stub hook asks for sponsorship only to have a paymaster to simulate
 * with, and hands back NONE of the sponsor's gas figures — viem then estimates
 * on the bundler. The final hook re-sponsors over the bundler's estimate plus a
 * drift margin (the sponsor keeps a pre-filled `preVerificationGas` — measured),
 * so the paymaster signature covers a number the bundler will accept.
 *
 * Pure over an injected `sponsor` so the hooks are unit-testable; kernel-account
 * supplies the ZeroDev client's `sponsorUserOperation`.
 */
import type {
  GetPaymasterDataParameters,
  GetPaymasterDataReturnType,
  GetPaymasterStubDataParameters,
  GetPaymasterStubDataReturnType,
} from "viem/account-abstraction";

/**
 * Head-room over the bundler's `preVerificationGas` estimate for the L1 base fee
 * moving between estimate and send. The field is charged in full, so this is
 * real money — ~16k gas ≈ 0.0000004 ETH per op at Arbitrum prices, which is
 * cheaper than one failed setup.
 */
export const PRE_VERIFICATION_GAS_MARGIN_PERCENT = 20n;

export function withPreVerificationGasMargin(preVerificationGas: bigint): bigint {
  return preVerificationGas + (preVerificationGas * PRE_VERIFICATION_GAS_MARGIN_PERCENT) / 100n;
}

/** The shape `zd_sponsorUserOperation` answers with for EntryPoint 0.7 (a superset of viem's final-step return). */
export type SponsorResult = GetPaymasterDataReturnType & {
  callGasLimit?: bigint;
  verificationGasLimit?: bigint;
  preVerificationGas?: bigint;
};

export type SponsorFn = (args: {
  userOperation: GetPaymasterDataParameters;
  /** `false` for the stub request — it is thrown away, so it must not count against the policy. */
  shouldConsume?: boolean;
}) => Promise<SponsorResult>;

export function sponsoredPaymasterHooks(sponsor: SponsorFn): {
  getPaymasterStubData: (userOperation: GetPaymasterStubDataParameters) => Promise<GetPaymasterStubDataReturnType>;
  getPaymasterData: (userOperation: GetPaymasterDataParameters) => Promise<GetPaymasterDataReturnType>;
} {
  return {
    async getPaymasterStubData(userOperation) {
      const s = await sponsor({ userOperation: userOperation as GetPaymasterDataParameters, shouldConsume: false });
      // Paymaster fields ONLY. Returning a gas field here is what silences the
      // bundler estimate — see the module comment.
      return {
        paymaster: s.paymaster,
        paymasterData: s.paymasterData,
        paymasterVerificationGasLimit: s.paymasterVerificationGasLimit,
        paymasterPostOpGasLimit: s.paymasterPostOpGasLimit,
        isFinal: false,
      } as GetPaymasterStubDataReturnType;
    },
    async getPaymasterData(userOperation) {
      const estimated = userOperation.preVerificationGas;
      if (typeof estimated !== "bigint") {
        throw new Error(
          "preVerificationGas is missing before sponsorship — the bundler estimate was skipped, and the sponsor's own figure is not safe to send on Arbitrum One (#517)",
        );
      }
      return sponsor({
        userOperation: { ...userOperation, preVerificationGas: withPreVerificationGasMargin(estimated) },
      });
    },
  };
}
