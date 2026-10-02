/**
 * The canonical request challenge a session key signs (auth v2), and the body
 * hash it commits to. One copy for every signer - the store's `signRequest` and
 * the added-passkey verdict (#746), which signs before any session is stored -
 * because the server rebuilds it byte for byte (`middleware/auth.ts`).
 */

export function requestChallenge(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  bodyHash: string,
): string {
  return ["woco-session-v1", method.toUpperCase(), path, timestamp, nonce, bodyHash].join("\n");
}

/** SHA-256 hex of a UTF-8 string (for request body binding). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
