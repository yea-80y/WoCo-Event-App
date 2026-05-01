// OAuth password-flow token client for Etherna gateway.
//
// API key shape from sso.etherna.io is `<id>.<secret>` and maps to
// `username`/`password` in OAuth's password grant. The OAuth `client_id` is
// separate (issued per-integrator by Etherna, set via ETHERNA_CLIENT_ID).
// Reference: github.com/Etherna/etherna-authentication
// (src/EthernaAuthentication.Native/PasswordFlow/EthernaApiKeySignInService.cs)

const REFRESH_MARGIN_MS = 30_000;

interface TokenCache {
  token: string;
  expiresAt: number;
}

let cache: TokenCache | null = null;
let inflight: Promise<TokenCache> | null = null;

function isEnabled(): boolean {
  return process.env.ETHERNA_ENABLED === "true";
}

async function fetchToken(): Promise<TokenCache> {
  const apiKey = process.env.ETHERNA_API_KEY ?? "";
  // Etherna's well-known public OAuth client for API-key password-flow auth.
  // Confirmed by Etherna 2026-04-29 — same value for all integrators.
  const clientId = process.env.ETHERNA_CLIENT_ID ?? "apiKeyClientId";
  const tokenEndpoint = process.env.ETHERNA_TOKEN_ENDPOINT ?? "https://sso.etherna.io/connect/token";
  const scope = process.env.ETHERNA_SCOPES ?? "openid profile offline_access ether_accounts role userApi.gateway";

  if (!apiKey) throw new Error("ETHERNA_API_KEY not configured");

  const dot = apiKey.indexOf(".");
  if (dot === -1) throw new Error("ETHERNA_API_KEY must be in <id>.<secret> form");

  const body = new URLSearchParams({
    grant_type: "password",
    client_id: clientId,
    username: apiKey.slice(0, dot),
    password: apiKey.slice(dot + 1),
    scope,
  });

  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Etherna token request failed: ${res.status} ${detail}`);
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  return {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
}

/** Populate or refresh the in-memory token cache. No-op when ETHERNA_ENABLED!=true. */
export async function ensureEthernaToken(): Promise<void> {
  if (!isEnabled()) return;
  if (cache && cache.expiresAt - REFRESH_MARGIN_MS > Date.now()) return;
  if (!inflight) {
    inflight = fetchToken().finally(() => {
      inflight = null;
    });
  }
  cache = await inflight;
}

/** Synchronous read used by bee-js onRequest. Returns "" when no token. */
export function getCachedEthernaToken(): string {
  if (!isEnabled() || !cache) return "";
  return cache.token;
}

/** Force-discard cached token (e.g. on 401 from gateway). */
export function clearEthernaToken(): void {
  cache = null;
}
