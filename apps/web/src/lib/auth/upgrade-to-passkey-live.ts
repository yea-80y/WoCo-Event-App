/**
 * The live deps of the email -> passkey upgrade (#746): upgrade-to-passkey.ts is the
 * flow, this is the I/O it runs on. The store lends only what is its own (`UpgradeHost`);
 * everything else is the app's existing rails, each loaded when the step needs it.
 */

import { profileAvatarContentTopic, profileDataContentTopic } from "@woco/shared";
import type { FeedKey, PrepareDeps, ProfileCopy, SocialDeps, UpgradeIO, UpgradeStoreHost } from "./upgrade-to-passkey.js";
import { localMarkerStore } from "./upgrade-marker.js";

/** The runners' I/O, live. */
export function liveUpgradeIO(host: UpgradeStoreHost): UpgradeIO {
  return {
    marker: localMarkerStore,
    prepareDeps: (account) => liveUpgradeDeps(host, account),
    social: liveSocialDeps,
  };
}

/** An envelope just written may take a moment to read back through the gateway. */
const ENVELOPE_READ_ATTEMPTS = 4;
const ENVELOPE_READ_DELAY_MS = 2_000;

/**
 * Does the account host events or websites? Their feed signer is pinned where the
 * money path reads it (event-feed-signers.json is write-once; a site's events index
 * carries it), so such an account keeps its seed and cannot be upgraded.
 */
export async function hostsSomething(parent: string): Promise<boolean | "unknown"> {
  const { getMyEventsSWR, getMySitesSWR } = await import("../api/creator-cache.js");
  const [events, sites] = await Promise.all([getMyEventsSWR(parent).refresh(), getMySitesSWR(parent).refresh()]);
  if (!events.ok || !sites.ok) return "unknown";
  return (events.data?.length ?? 0) > 0 || (sites.data?.length ?? 0) > 0;
}

export async function liveSocialDeps(): Promise<SocialDeps> {
  const [{ readLiveSubjects }, { writeStatement }] = await Promise.all([
    import("../social/live-subjects.js"),
    import("../social/social-core.js"),
  ]);
  return {
    readLive: (feed, kind) => readLiveSubjects({ address: feed }, kind),
    write: async (signer, kind, subject, value) => (await writeStatement(signer, kind, subject, value)).ok,
  };
}

export async function liveUpgradeDeps(
  host: UpgradeStoreHost,
  account: { parent: string; emailKey: string },
): Promise<PrepareDeps> {
  const parent = account.parent.toLowerCase();
  const social = await liveSocialDeps();
  return {
    parent,
    emailKey: account.emailKey,
    marker: localMarkerStore,
    social,
    oldSeed: () => host.oldSeed(),
    removeBackups: () => host.removeBackups(),
    putBinding: (passkey, at) => host.putBinding(passkey, at),

    hostsSomething: () => hostsSomething(parent),

    readReferrer: async (feed) => (await import("../campaign/records.js")).readLiveReferrer(feed),

    readProfile: async (feed) => {
      const [{ readContentFeedResult }, { FEED_ROUTES }] = await Promise.all([
        import("../swarm/content-feed.js"),
        import("../swarm/gateways.js"),
      ]);
      // Thorough: a false "absent" here would leave the account's profile behind.
      const opts = { thorough: true, route: FEED_ROUTES.profile };
      const [data, avatar] = await Promise.all([
        readContentFeedResult<unknown>(feed, profileDataContentTopic(parent), opts),
        readContentFeedResult<unknown>(feed, profileAvatarContentTopic(parent), opts),
      ]);
      if (data.status === "unavailable" || avatar.status === "unavailable") return "unavailable";
      const copy: ProfileCopy = {
        data: data.status === "found" ? data.value : null,
        avatar: avatar.status === "found" ? avatar.value : null,
      };
      return copy.data || copy.avatar ? copy : null;
    },

    mintPasskey: async () => {
      const { createPasskeyAccountUnpinned } = await import("./passkey-account.js");
      const fresh = await createPasskeyAccountUnpinned();
      return { address: fresh.address, privateKey: fresh.privateKey, prfSecret: fresh.prfSecret, credential: fresh.credential };
    },

    storeLockedSeed: async (passkey, at, seed, prfSecret) => {
      const { storeLockedSeed } = await import("./identity-seed.js");
      await storeLockedSeed(passkey, at, seed, prfSecret);
    },

    clearPasskeyState: async (passkey) => {
      const { clearLockedSeed } = await import("./identity-seed.js");
      await host.clearBinding(passkey);
      await clearLockedSeed(passkey);
    },

    writeEnvelope: async ({ prfSecret, parent: at, seed }) => {
      const { backfillPortabilityEnvelope } = await import("./recovery-portability.js");
      const outcome = await backfillPortabilityEnvelope({ prfSecret, preservedKernelAddress: at, identitySeed: seed });
      if (outcome.action !== "wrote" && outcome.action !== "skipped") throw new Error(`envelope ${outcome.action}: ${outcome.reason}`);
    },

    readEnvelope: async (prfSecret) => {
      const { readPortabilityEnvelope } = await import("./recovery-portability.js");
      for (let attempt = 0; attempt < ENVELOPE_READ_ATTEMPTS; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, ENVELOPE_READ_DELAY_MS));
        const read = await readPortabilityEnvelope({ prfSecret });
        if (read.status === "found") return { parent: read.value.preservedKernelAddress, seed: read.value.identitySeed };
      }
      return null;
    },

    writeProfile: async (signer: FeedKey, copy: ProfileCopy) => {
      const [{ writeContentFeed }, { FEED_ROUTES }] = await Promise.all([
        import("../swarm/content-feed.js"),
        import("../swarm/gateways.js"),
      ]);
      const route = FEED_ROUTES.profile;
      if (copy.data) await writeContentFeed({ signerPrivKey: signer.privKey, topic: profileDataContentTopic(parent), data: copy.data, route });
      if (copy.avatar) {
        await writeContentFeed({ signerPrivKey: signer.privKey, topic: profileAvatarContentTopic(parent), data: copy.avatar, route });
      }
    },

    writeReferral: async (signer, referrer) => {
      const { writeReferralStatement } = await import("../campaign/records.js");
      const written = await writeReferralStatement(signer, referrer);
      if (written.status === "superseded") throw new Error("referral statement superseded");
    },
  };
}
