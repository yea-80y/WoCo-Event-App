/**
 * The gasless (Kernel session key) rail refusing a permit it cannot serve.
 *
 * `registerSubEnsViaPermit` cross-checks the permit against the registrar and
 * chain the session key's CallPolicy is pinned to, and refuses to submit when
 * they differ. That refusal is CORRECT — submitting anyway spends a sponsored
 * userOp the permission validator will reject — but it is not a failure of the
 * user's request: the sponsor rail mints the SAME name, never touches the
 * session key, mints to the server-verified parent, and is bounded by the
 * per-recipient rate cap. So the caller should fall back rather than surface it.
 *
 * Typed, because the caller has to tell "this rail cannot serve this permit"
 * apart from "the mint itself failed" — and #491 is the standing lesson that
 * classifying an error by matching its MESSAGE TEXT is how a fallback fires for
 * the wrong reason.
 */

export type GaslessRailReason = "registrar_mismatch" | "chain_mismatch";

export class GaslessRailUnavailable extends Error {
  override readonly name = "GaslessRailUnavailable";
  constructor(message: string, readonly reason: GaslessRailReason) {
    super(message);
  }
}

/**
 * Name-based, not `instanceof` and not message-based: `instanceof` fails across
 * a bundle or module boundary that loaded this file twice (the whole rail is
 * behind dynamic imports), and matching text is the #491 defect. The `name`
 * field is a stable own property set at construction.
 */
export function isGaslessRailUnavailable(err: unknown): err is GaslessRailUnavailable {
  return err instanceof Error && err.name === "GaslessRailUnavailable";
}
