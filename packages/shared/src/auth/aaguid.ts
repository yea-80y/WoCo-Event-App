/**
 * The AAGUID in WebAuthn authenticator data, as a lowercase UUID, or null when the
 * data carries none: shorter than the fixed header, the attested-credential flag
 * (0x40 in the flags byte at 32) unset, or all zero - what an authenticator sends
 * when it chooses not to say.
 */
export function aaguidFromAuthenticatorData(authData: Uint8Array): string | null {
  // rpIdHash 32 | flags 1 | signCount 4 | aaguid 16
  if (authData.length < 53 || (authData[32]! & 0x40) === 0) return null;
  const bytes = authData.subarray(37, 53);
  if (bytes.every((b) => b === 0)) return null;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
