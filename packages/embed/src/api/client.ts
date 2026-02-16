export interface ApiClient {
  get<T = unknown>(path: string): Promise<{ ok: boolean; data?: T; error?: string }>;
  post<T = unknown>(path: string, body: unknown): Promise<{ ok: boolean; data?: T; error?: string } & Record<string, unknown>>;
}

export function createApiClient(baseUrl: string): ApiClient {
  const base = baseUrl.replace(/\/$/, "");

  return {
    async get<T>(path: string) {
      const resp = await fetch(`${base}${path}`);
      return resp.json() as Promise<{ ok: boolean; data?: T; error?: string }>;
    },

    async post<T>(path: string, body: unknown) {
      const resp = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return resp.json() as Promise<{ ok: boolean; data?: T; error?: string } & Record<string, unknown>>;
    },
  };
}
