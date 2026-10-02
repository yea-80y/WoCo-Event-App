/**
 * Which password manager holds a passkey (#746), read from the AAGUID its creation
 * reports and kept with the credential ON THE DEVICE: for the "Your passkeys"
 * labels and advice that depends on the manager. Never sent to the server - which
 * manager holds an account's keys tells someone which account to attack - and never
 * a security signal: without attestation the AAGUID is the authenticator's word.
 *
 * The AAGUID exists only in the CREATION response, never at sign-in, so a passkey
 * made before this was read cannot be identified later.
 *
 * AAGUIDs from the community list github.com/passkeydeveloper/passkey-authenticator-aaguids
 * (aaguid.json at 3ff200dcb393, 2026-09-28). Kept to the managers people use; anything
 * else is "other", and a missing or all-zero AAGUID is "unknown".
 */

export const PASSKEY_PROVIDERS = {
  "google-password-manager": { name: "Google Password Manager", aaguids: ["ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4"] },
  "apple-passwords": {
    name: "Apple Passwords",
    aaguids: ["fbfc3007-154e-4ecc-8c0b-6e020557d7bd", "dd4ec289-e01d-41c9-bb89-70fa845d4bf2"],
  },
  "samsung-pass": { name: "Samsung Pass", aaguids: ["53414d53-554e-4700-0000-000000000000"] },
  "windows-hello": {
    name: "Windows Hello",
    aaguids: [
      "08987058-cadc-4b81-b6e1-30de50dcbe96",
      "9ddd1817-af5a-4672-a2b9-3e3dd95000a9",
      "6028b017-b1d4-4c02-b4b3-afcdafc96bb2",
    ],
  },
  "microsoft-password-manager": { name: "Microsoft Password Manager", aaguids: ["d3452668-01fd-4c12-926c-83a4204853aa"] },
  "chrome-mac": { name: "Chrome on Mac", aaguids: ["adce0002-35bc-c60a-648b-0b25f1f05503"] },
  "1password": { name: "1Password", aaguids: ["bada5566-a7aa-401f-bd96-45619a55120d"] },
  bitwarden: { name: "Bitwarden", aaguids: ["d548826e-79b4-db40-a3d8-11116f7e8349"] },
  dashlane: { name: "Dashlane", aaguids: ["531126d6-e717-415c-9320-3d9aa6981239"] },
  "proton-pass": { name: "Proton Pass", aaguids: ["50726f74-6f6e-5061-7373-50726f746f6e"] },
} as const;

export type PasskeyProviderId = keyof typeof PASSKEY_PROVIDERS | "other" | "unknown";

export const PASSKEY_PROVIDER_IDS: readonly PasskeyProviderId[] = [
  ...(Object.keys(PASSKEY_PROVIDERS) as (keyof typeof PASSKEY_PROVIDERS)[]),
  "other",
  "unknown",
];

const BY_AAGUID = new Map<string, PasskeyProviderId>(
  Object.entries(PASSKEY_PROVIDERS).flatMap(([id, p]) =>
    p.aaguids.map((a) => [a, id as PasskeyProviderId] as const),
  ),
);

export function isPasskeyProviderId(v: unknown): v is PasskeyProviderId {
  return typeof v === "string" && (PASSKEY_PROVIDER_IDS as readonly string[]).includes(v);
}

export function passkeyProviderFromAaguid(aaguid: string | null): PasskeyProviderId {
  if (!aaguid) return "unknown";
  return BY_AAGUID.get(aaguid.toLowerCase()) ?? "other";
}

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
