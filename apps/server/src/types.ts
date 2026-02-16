/** Hono environment with custom context variables set by auth middleware. */
export type AppEnv = {
  Variables: {
    parentAddress: string;
    sessionAddress: string;
    body: Record<string, unknown>;
  };
};
