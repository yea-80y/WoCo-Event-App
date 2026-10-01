import type { SessionRank } from "@woco/shared";

/** Hono environment with custom context variables set by auth middleware. */
export type AppEnv = {
  Variables: {
    parentAddress: string;
    sessionAddress: string;
    /** "device" = signed by a key the owner granted (#746), not the owner. */
    sessionRank: SessionRank;
    body: Record<string, unknown>;
  };
};
