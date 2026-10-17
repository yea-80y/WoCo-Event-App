/**
 * Roster encryption — AES-256-GCM under the roster key, an HKDF child of the pass
 * secret P the door-pass URL fragment carries (`doorRosterKey`). Encrypt lives here
 * too (used by the organiser dashboard) so both sides share one wire format:
 * { iv: b64, ciphertext: b64 } over UTF-8 JSON.
 *
 * Both sides keep only the door's keys (`pickRosterEntries`): a roster pushed before
 * the door list was cut down to name and email still carries order answers, and
 * they never reach a phone's memory or storage.
 */

import { base64UrlDecode, type EncryptedRoster, type RosterEntry } from "@woco/shared";
import { doorRosterKey } from "@woco/shared/checkin/door-keys";

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

async function importKey(passSecretB64url: string, usage: KeyUsage): Promise<CryptoKey> {
  const p = base64UrlDecode(passSecretB64url);
  if (p.length !== 32) throw new Error("Door pass secret must be 32 bytes");
  const raw = doorRosterKey(p);
  try {
    return await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [usage]);
  } finally {
    raw.fill(0);
    p.fill(0);
  }
}

/** The ticket, a name and an email; anything else on an entry is dropped. */
export function pickRosterEntries(list: unknown): RosterEntry[] {
  if (!Array.isArray(list)) return [];
  const out: RosterEntry[] = [];
  for (const e of list as Partial<RosterEntry>[]) {
    if (!e || typeof e !== "object" || typeof e.seriesId !== "string" || !Number.isInteger(e.edition)) continue;
    out.push({
      seriesId: e.seriesId,
      seriesName: typeof e.seriesName === "string" ? e.seriesName : "",
      edition: e.edition as number,
      ...(typeof e.name === "string" && e.name ? { name: e.name } : {}),
      ...(typeof e.email === "string" && e.email ? { email: e.email } : {}),
    });
  }
  return out;
}

export async function encryptRoster(
  entries: RosterEntry[],
  passSecretB64url: string,
): Promise<Pick<EncryptedRoster, "iv" | "ciphertext">> {
  const key = await importKey(passSecretB64url, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(pickRosterEntries(entries)));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { iv: b64encode(iv), ciphertext: b64encode(new Uint8Array(ciphertext)) };
}

export async function decryptRoster(roster: EncryptedRoster, passSecretB64url: string): Promise<RosterEntry[]> {
  const key = await importKey(passSecretB64url, "decrypt");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(roster.iv) as BufferSource },
    key,
    b64decode(roster.ciphertext) as BufferSource,
  );
  return pickRosterEntries(JSON.parse(new TextDecoder().decode(plaintext)));
}
