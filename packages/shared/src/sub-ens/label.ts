/**
 * Mirror of WoCoRegistrar._validLabel — the rules a `.woco.eth` label must pass
 * before the registrar will mint it.
 *
 * Shared, not duplicated, because the client and the server drifted: a looser
 * client prefilter let `ab` through to `/api/sub-ens/check`, which answered
 * `{ available: false, reason }` with no owner — and the resolver, correctly
 * refusing to read absence into a partial answer, told the user "name is
 * registered but its owner could not be read" about a label that could never
 * have been minted at all.
 *
 * Returns the user-facing reason, or null when the label is valid.
 */
export function validateLabel(label: string): string | null {
  if (label.length < 3 || label.length > 63) return "label must be 3–63 characters";
  if (!/^[a-z0-9]/.test(label))              return "label must start with a letter or digit";
  if (!/[a-z0-9]$/.test(label))              return "label must end with a letter or digit";
  if (!/^[a-z0-9-]+$/.test(label))           return "label may only contain a–z, 0–9, and hyphens";
  if (label.includes("--"))                   return "label cannot contain consecutive hyphens";
  return null;
}
