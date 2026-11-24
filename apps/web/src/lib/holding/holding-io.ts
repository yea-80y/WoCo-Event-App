/**
 * The live Swarm I/O behind `account-copy.ts`: the `holding` feed family's route, thorough
 * reads, and saves that target the version a thorough read proved next and read the bytes
 * back (`writeAtNextVersion`). Lazy: the feed code loads on first use.
 */
import { FEED_ROUTES } from "../swarm/gateways.js";
import type { HoldingFeedIO } from "./account-copy.js";

const ROUTE = FEED_ROUTES.holding;

export const liveHoldingFeedIO: HoldingFeedIO = {
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
};
