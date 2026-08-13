/**
 * Name→address resolution for the recovery portal's manual fallback (#177) —
 * pure classification, no fetch, no env, so it is testable under node.
 *
 * Three answers, kept apart (the #169 class, by the name route): "none" is
 * DEFINITIVE (malformed label, or the registrar answered "available", i.e.
 * unregistered) and may render as "no backup found"; "error" is a lookup
 * nobody answered — a throw, an error envelope, or a registered name whose
 * owner did not come back readable — and must never render as absence,
 * because the portal's "none" copy tells a recoverable, locked-out user that
 * recovery is impossible.
 */

/** The shape `checkSubEnsLabel` resolves with — declared here so this module
 *  needs nothing from the fetch layer. */
export interface SubEnsCheckResponse {
  ok: boolean;
  data?: { available: boolean; owner?: string };
  error?: string;
}

export type SubEnsResolve =
  | { status: "found"; address: string }
  | { status: "none" }
  | { status: "error"; reason: string };

export async function resolveSubEnsWith(
  check: (label: string) => Promise<SubEnsCheckResponse>,
  input: string,
): Promise<SubEnsResolve> {
  const label = input.trim().toLowerCase().replace(/\.woco\.eth$/, "");
  if (!/^[a-z0-9-]{1,63}$/.test(label)) return { status: "none" };
  let res: SubEnsCheckResponse;
  try {
    res = await check(label);
  } catch (e) {
    return { status: "error", reason: e instanceof Error ? e.message : "lookup failed" };
  }
  if (!res.ok || !res.data) return { status: "error", reason: res.error ?? "lookup failed" };
  if (res.data.available) return { status: "none" };
  // Registered, so an owner EXISTS on-chain — one that did not come back
  // readable is a partial answer, not proof of absence.
  const owner = res.data.owner;
  return owner && /^0x[a-fA-F0-9]{40}$/.test(owner)
    ? { status: "found", address: owner.toLowerCase() }
    : { status: "error", reason: "name is registered but its owner could not be read" };
}
