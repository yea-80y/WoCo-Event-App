/**
 * Roster encryption — AES-256-GCM under the key carried in the door-pass URL
 * fragment. Encrypt lives here too (used by the organiser dashboard) so both
 * sides share one wire format: { iv: b64, ciphertext: b64 } over UTF-8 JSON.
 */

import { base64UrlDecode, base64UrlEncode, type EncryptedRoster, type RosterEntry } from "@woco/shared";

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function generateRosterKeyB64url(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

async function importKey(keyB64url: string, usage: KeyUsage): Promise<CryptoKey> {
  const raw = base64UrlDecode(keyB64url);
  if (raw.length !== 32) throw new Error("Roster key must be 32 bytes");
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [usage]);
}

export async function encryptRoster(
  entries: RosterEntry[],
  keyB64url: string,
): Promise<Pick<EncryptedRoster, "iv" | "ciphertext">> {
  const key = await importKey(keyB64url, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(entries));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { iv: b64encode(iv), ciphertext: b64encode(new Uint8Array(ciphertext)) };
}

export async function decryptRoster(roster: EncryptedRoster, keyB64url: string): Promise<RosterEntry[]> {
  const key = await importKey(keyB64url, "decrypt");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(roster.iv) as BufferSource },
    key,
    b64decode(roster.ciphertext) as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as RosterEntry[];
}
