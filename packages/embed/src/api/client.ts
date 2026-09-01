export interface ApiClient {
  get<T = unknown>(path: string): Promise<{ ok: boolean; data?: T; error?: string }>;
  post<T = unknown>(path: string, body: unknown): Promise<{ ok: boolean; data?: T; error?: string } & Record<string, unknown>>;
}

/**
 * A non-JSON body (a proxy error page, Hono's plain-text default 404) must
 * surface as a readable failure, not a JSON.parse throw — the widget runs on
 * organiser pages where an uncaught parse error reads as "the button is dead".
 */
async function parseJson<T>(resp: Response): Promise<{ ok: boolean; data?: T; error?: string } & Record<string, unknown>> {
  try {
    return await resp.json() as { ok: boolean; data?: T; error?: string } & Record<string, unknown>;
  } catch {
    return { ok: false, error: `Request failed (HTTP ${resp.status})` };
  }
}

export function createApiClient(baseUrl: string): ApiClient {
  const base = baseUrl.replace(/\/$/, "");

  return {
    async get<T>(path: string) {
      const resp = await fetch(`${base}${path}`);
      return parseJson<T>(resp);
    },

    async post<T>(path: string, body: unknown) {
      const resp = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return parseJson<T>(resp);
    },
  };
}
