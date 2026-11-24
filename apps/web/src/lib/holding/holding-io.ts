/**
 * The live Swarm I/O behind `account-copy.ts`: the `holding` feed family's route, thorough
 * reads, and saves that target the version a thorough read proved next and read the bytes
 * back (`writeAtNextVersion`). Lazy: the feed code loads on first use.
 *
 * Saves for one copy signer take turns across this browser's tabs (a Web Lock), and a
 * save that another device beat to a version waits a random moment before trying again,
 * so two writers do not keep meeting at the next one (Fable 3c PR 1).
 *
 * Two of them: `liveHoldingFeedIO` for a save the person pressed for (the Keep page, an
 * upgrade, a passkey removal), and `backgroundHoldingFeedIO` for the automatic collection,
 * whose saves never start a sign-in - a session that lapsed mid-run fails the save
 * instead of opening the passkey window (Fable 3c PR 2, 2).
 */
import type { SocTransport } from "../swarm/content-feed.js";
import { FEED_ROUTES } from "../swarm/gateways.js";
import { withWebLock } from "../utils/web-lock.js";
import type { HoldingFeedIO } from "./account-copy.js";

const ROUTE = FEED_ROUTES.holding;

/** One save of a copy, or of the list, may hold the lock this long: saves read back, and retry. */
export const HOLDING_SAVE_LOCK_MS = 180_000;

/** Between 0.5 and 3 s, at random. */
export function holdingSaveBackoffMs(random: () => number = Math.random): number {
  return 500 + Math.floor(random() * 2_500);
}

/** The relay, signed with the session already here, never a new sign-in. Loaded on use. */
const backgroundTransport: SocTransport = async (body) =>
  (await import("../swarm/client-soc.js")).postSignedSoc(body, { establish: false });

function holdingFeedIO(opts: { background: boolean }): HoldingFeedIO {
  return {
    async readBase(owner, topic) {
      const { readContentFeedWriteBase } = await import("../swarm/content-feed.js");
      return readContentFeedWriteBase(owner, topic, { route: ROUTE, skipLegacy: true });
    },
    async write({ signer, topic, base, build }) {
      const [{ writeAtNextVersion }, { InconclusiveReadError }, { HoldingSaveError }] = await Promise.all([
        import("../swarm/verified-write.js"),
        import("../swarm/late-retry.js"),
        import("./account-copy.js"),
      ]);
      try {
        const { written } = await writeAtNextVersion({
          signerPrivKey: signer.privKey,
          ownerAddress: signer.address,
          topic,
          route: ROUTE,
          skipLegacy: true,
          base,
          build,
          inconclusive: "Your saved receipts could not be read just now - try again in a moment.",
          onSuperseded: () => new Promise((resolve) => setTimeout(resolve, holdingSaveBackoffMs())),
          // A pressed save keeps the default transport (which may renew the session).
          ...(opts.background ? { transport: backgroundTransport } : {}),
        });
        return written.status === "verified" ? "verified" : "unconfirmed";
      } catch (e) {
        // Written for the person; anything else stays a plain error the page does not show.
        if (e instanceof InconclusiveReadError) throw new HoldingSaveError(e.message);
        throw e;
      }
    },
    async read(owner, topic) {
      const { readContentFeedResult } = await import("../swarm/content-feed.js");
      return readContentFeedResult(owner, topic, { route: ROUTE, skipLegacy: true, thorough: true });
    },
    async readAt(owner, topic, version) {
      const { readContentFeedAtVersion } = await import("../swarm/content-feed.js");
      return readContentFeedAtVersion(owner, topic, version, { route: ROUTE, thorough: true });
    },
    exclusive(owner, save) {
      return withWebLock(`woco:holding:save:${owner.toLowerCase()}`, save, {
        timeoutMs: HOLDING_SAVE_LOCK_MS,
        timeoutMessage: "Saving your receipt took too long - try again in a moment.",
      });
    },
  };
}

export const liveHoldingFeedIO: HoldingFeedIO = holdingFeedIO({ background: false });
export const backgroundHoldingFeedIO: HoldingFeedIO = holdingFeedIO({ background: true });
