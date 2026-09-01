/**
 * Branded key/address types (PR 2 of the issuer-curve migration, #443/#444).
 *
 * `Hex32 = string` let an ed25519 holder key, an X25519 encryption key and an
 * issuer key flow into one another unchecked — three semantically different
 * secrets sharing one 64-hex shape. #445 (a 0x-prefixed pubkey crossing a JSON
 * boundary) is the class these exist to kill: brands catch KIND confusion at
 * compile time; the constructors catch VALUE defects where JSON enters.
 *
 * Rules the constructors enforce — REFUSE, never normalise. The lenient
 * strip-and-case-fold path inside `verifySignedManifest` is exactly the trap
 * door.test.ts documents; boundaries must reject non-canonical input so a
 * producer bug is caught at ingestion, not laundered into the store.
 *
 * `IssuerAddress` is defined here ahead of PR 3 (nothing constructs one yet):
 * the v2 issuer identity is a 20-byte eth address — shape-distinct from every
 * 64-hex key, which is itself part of the defence.
 */

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** Bare lowercase 64-hex ed25519 HOLDER public key (attendee identity). */
export type HolderPubkey = Brand<string, "HolderPubkey">;
/** Bare lowercase 64-hex X25519 ENCRYPTION public key (sealed-order recipient). */
export type EncryptionPubkey = Brand<string, "EncryptionPubkey">;
// `IssuerPubkeyV1` (the branded ed25519 v1 issuer key) was DELETED in PR 4
// with the web v1 producers — its removal forced the issuer-site audit exactly
// where the curve changed. The surviving v1 VERIFY paths (`pod/` + `pod-cert/`,
// condemned, deleted in PR 5a) carry plain `string` issuer keys until then.
/** 0x-prefixed lowercase 20-byte eth address — the v2 issuer identity unit. */
export type IssuerAddress = Brand<string, "IssuerAddress">;

const BARE_KEY_RE = /^[0-9a-f]{64}$/;
const ETH_ADDRESS_RE = /^0x[0-9a-f]{40}$/;

function refuse(kind: string, expected: string, v: unknown): never {
  const got =
    typeof v !== "string"
      ? typeof v
      : v.length === 0
        ? "empty string"
        : `"${v.length > 20 ? v.slice(0, 20) + "…" : v}" (${v.length} chars)`;
  throw new Error(`invalid ${kind}: expected ${expected}, got ${got}`);
}

/** Validate + brand a holder public key. Throws on non-canonical input. */
export function asHolderPubkey(v: unknown): HolderPubkey {
  if (typeof v === "string" && BARE_KEY_RE.test(v)) return v as HolderPubkey;
  refuse("holder pubkey", "bare lowercase 64-hex ed25519 key", v);
}

/** Validate + brand an encryption public key. Throws on non-canonical input. */
export function asEncryptionPubkey(v: unknown): EncryptionPubkey {
  if (typeof v === "string" && BARE_KEY_RE.test(v)) return v as EncryptionPubkey;
  refuse("encryption pubkey", "bare lowercase 64-hex X25519 key", v);
}

/** Validate + brand a v2 issuer address. Throws on non-canonical input. */
export function asIssuerAddress(v: unknown): IssuerAddress {
  if (typeof v === "string" && ETH_ADDRESS_RE.test(v)) return v as IssuerAddress;
  refuse("issuer address", "0x-prefixed lowercase 20-byte eth address", v);
}

/** Non-throwing guards, for validators that return false instead of throwing. */
export const isHolderPubkey = (v: unknown): v is HolderPubkey =>
  typeof v === "string" && BARE_KEY_RE.test(v);
export const isEncryptionPubkey = (v: unknown): v is EncryptionPubkey =>
  typeof v === "string" && BARE_KEY_RE.test(v);
export const isIssuerAddress = (v: unknown): v is IssuerAddress =>
  typeof v === "string" && ETH_ADDRESS_RE.test(v);
