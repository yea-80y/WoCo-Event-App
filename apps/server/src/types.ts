import type { SessionRank } from "@woco/shared";

/** Hono environment with custom context variables set by auth middleware. */
export type AppEnv = {
  Variables: {
    parentAddress: string;
    sessionAddress: string;
    /** "device" = signed by a key the owner granted (#746), not the owner. */
    sessionRank: SessionRank;
    /** What the parent is, as its delegation proved (#746 step 5); unset = unknown, never assumed. */
    parentKind: "eoa" | "kernel" | "smart-wallet" | undefined;
    body: Record<string, unknown>;
  };
};
