/**
 * The real steps `rotate.ts` sequences when a passkey is removed (#186). Lazy: loaded
 * on the tap, never with a page.
 *
 * The account's own events and site configs are read straight from Swarm under the
 * signer this device holds (only the lists of ids come from the platform indexes), so
 * what is re-signed is exactly what the organiser signed.
 */
import { eventPageFeedTopic, multisiteFeedTopic } from "@woco/shared";
import type { ContentFeedSigner } from "../swarm/content-feed.js";
import type { AccountChain } from "../auth/account-chain.js";
import type { PasskeyKeys } from "./members.js";
import type { NewKeys, PendingRotation, RotationProgress, RotationSteps } from "./rotate.js";

/** What the auth store lends a removal: its state, and the steps only it can take. */
export interface RotationHost {
  parent: string;
  self: PasskeyKeys;
  seed: string;
  chain: AccountChain | null;
  /** The account's CURRENT signer and secrets - the generation being left. */
  oldSigner: ContentFeedSigner;
  oldSecrets: string[];
  /** The flip: `going` off the list and the anchor onto `ring`, in one op. */
  flip(going: string[], ring: { prev: string | null; next: string }): Promise<{ confirmed: boolean }>;
  adopt(chain: AccountChain): Promise<void>;
  signTypedDataAsHolder(typed: unknown): Promise<string>;
  removeRecord(key: string): Promise<void>;
  progress(p: RotationProgress): void;
}

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const WOCO_APP_URL = import.meta.env.VITE_APP_URL ?? "https://woco.eth.limo";

function bytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function hex(b: Uint8Array): string {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function liveRotationSteps(h: RotationHost): RotationSteps {
  const parent = h.parent.toLowerCase();
  const self = h.self.address.toLowerCase();

  /**
   * Point a WoCo name at a deploy this removal just made - signed by the HOLDER with no
   * tap, so only when every value is pinned to what this device knows (#186): the name is
   * the one in the organiser's OWN signed copy (never the server's reply), the deploy's
   * feed is the organiser's and this device signed its update under the new key, and the
   * target is a feed manifest - read and hash-checked HERE, not taken from the reply - for
   * the new signer and the topic this device derives. Anything else is not signed: the
   * name keeps pointing where it did, and the done screen says to point it again.
   */
  async function repoint(
    ownLabel: string | undefined,
    deploy: { feedManifestHash?: string; subEns?: unknown },
    signedUnderNewKey: boolean,
    expected: { owner: string; topic: string },
  ): Promise<void> {
    const p = deploy.subEns as { status?: string; label?: string; target?: string } | undefined;
    if (p?.status !== "awaiting_signature") return;
    const { pointerBlockedReason } = await import("../sub-ens/pointer-policy.js");
    const ok =
      !!ownLabel &&
      p.label === ownLabel &&
      signedUnderNewKey &&
      typeof deploy.feedManifestHash === "string" &&
      /^[0-9a-f]{64}$/.test(deploy.feedManifestHash) &&
      p.target === deploy.feedManifestHash &&
      pointerBlockedReason("passkey", "site", "client", true, ownLabel) === null &&
      (await manifestFollows(deploy.feedManifestHash, expected));
    if (!ok) throw new Error(`the name ${ownLabel ?? p.label ?? "(unknown)"} was not re-pointed: the deploy did not match what this device signed`);
    const { pointNameAt } = await import("../sub-ens/pointer.js");
    await pointNameAt(ownLabel!, p.target!, (typed) => h.signTypedDataAsHolder(typed));
  }

  /**
   * Does the feed manifest at `hash` follow `owner`'s feed at `topic` (the topic string,
   * hashed here)? The root chunk is fetched and checked against its address on this
   * device, so the answer does not rest on whoever served it.
   */
  async function manifestFollows(hash: string, expected: { owner: string; topic: string }): Promise<boolean> {
    const [{ WOCO_GATEWAY_URL }, { calculateCacAddress }, { feedOfManifestChunk }, { keccak_256 }, { bytesToHex, utf8ToBytes }] =
      await Promise.all([
        import("../swarm/gateways.js"),
        import("@woco/shared/swarm/soc"),
        import("../sub-ens/event-name-link.js"),
        import("@noble/hashes/sha3.js"),
        import("@noble/hashes/utils.js"),
      ]);
    try {
      const res = await fetch(`${WOCO_GATEWAY_URL}/chunks/${hash}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return false;
      const raw = new Uint8Array(await res.arrayBuffer());
      if (raw.length <= 8 || bytesToHex(calculateCacAddress(raw.subarray(0, 8), raw.subarray(8))) !== hash) return false;
      const feed = feedOfManifestChunk(raw);
      return (
        !!feed &&
        feed.owner === expected.owner.toLowerCase().replace(/^0x/, "") &&
        feed.topic === bytesToHex(keccak_256(utf8ToBytes(expected.topic)))
      );
    } catch {
      return false;
    }
  }

  /**
   * The account's own events and sites, read straight from Swarm under the signer this
   * device holds - not through the server, so what is re-signed is exactly what the
   * organiser signed. Thorough reads: "absent" here decides what is copied, and an
   * unreadable feed stops the removal before anything changes (a skipped event would
   * be unreadable after the flip). Only the lists of ids come from the platform indexes.
   */
  async function readOwn<T>(signer: string, topic: string, family: "event" | "site"): Promise<T | null> {
    const [{ readContentFeedResult }, { FEED_ROUTES }] = await Promise.all([
      import("../swarm/content-feed.js"),
      import("../swarm/gateways.js"),
    ]);
    const route = family === "event" ? FEED_ROUTES.event : FEED_ROUTES.site;
    const res = await readContentFeedResult<T>(signer, topic, { route, thorough: true });
    // A found version from an inconclusive scan may not be the newest: copying it
    // could move an older version, so it stops the removal like an unreadable one.
    if (res.status === "unavailable" || (res.status === "found" && !res.scanClean)) {
      throw new Error("Couldn't read all of your events and websites - nothing was changed. Try again.");
    }
    return res.status === "found" ? res.value : null;
  }

  async function ownEvents(signer = h.oldSigner.address) {
    const [{ getEventsByCreatorResult }, { eventContentTopic }] = await Promise.all([
      import("../api/events.js"),
      import("@woco/shared"),
    ]);
    const res = await getEventsByCreatorResult(parent);
    if (!res.ok) throw new Error("Couldn't read your events - nothing was changed. Try again.");
    const out: import("@woco/shared").EventFeed[] = [];
    for (const e of res.data ?? []) {
      const feed = await readOwn<import("@woco/shared").EventFeed>(signer, eventContentTopic(e.eventId), "event");
      // Absent under this signer: platform-signed or another account's - not moved.
      if (!feed || feed.eventId !== e.eventId || feed.deleted) continue;
      out.push(feed);
    }
    return out;
  }

  async function ownSites() {
    const { getCreatorSites } = await import("../api/sites.js");
    const res = await getCreatorSites();
    if (!res.ok) throw new Error("Couldn't read your websites - nothing was changed. Try again.");
    return (res.data ?? []).filter((s) => s.siteFeedSigner?.toLowerCase() === h.oldSigner.address.toLowerCase());
  }

  async function ownSiteConfig(siteId: string, signer: string) {
    const { siteConfigTopic } = await import("@woco/shared");
    const site = await readOwn<import("@woco/shared").Site>(signer, siteConfigTopic(siteId), "site");
    if (!site || site.siteId !== siteId) throw new Error("Couldn't read one of your websites - nothing was changed. Try again.");
    return site;
  }

  return {
    parent,
    self,
    seed: h.seed,
    chain: h.chain,
    readAnchor: async () => (await import("../auth/kernel-account.js")).readRingAnchor(parent),
    readCoOwners: async () => {
      const r = await (await import("../auth/kernel-account.js")).readCoOwners(parent);
      return r === "error" || r === null ? "error" : r;
    },
    fetchRing: async (ref) => (await import("./ring-read.js")).fetchKeyRing(ref),
    selfMember: async () => (await import("./members.js")).memberOf(parent, h.self),
    newSecret: () => {
      const s = crypto.getRandomValues(new Uint8Array(32));
      try {
        return hex(s);
      } finally {
        s.fill(0);
      }
    },
    keysOf: async (secret) => {
      const { accountKeysOf } = await import("@woco/shared/keyring/account-secret");
      const k = accountKeysOf(bytes(secret));
      return { secret, feedSigner: k.feedSigner, orderKeyRef: k.orderKeyRef, orderPublicKey: k.orderKey.publicKey };
    },
    loadPending: async () => {
      const { openPendingRotation } = await import("./pending-rotation.js");
      return (await openPendingRotation(self, parent, h.self.prfSecret)) as PendingRotation | null;
    },
    savePending: async (p) => {
      const { storePendingRotation } = await import("./pending-rotation.js");
      await storePendingRotation(self, parent, p, h.self.prfSecret);
    },
    clearPending: async () => {
      const { clearPendingRotation } = await import("./pending-rotation.js");
      await clearPendingRotation(self);
    },

    copyEvents: async (keys, progress) => {
      const { signEventFeedSoc } = await import("../api/events.js");
      const events = await ownEvents();
      let done = 0;
      progress(0, events.length);
      for (const feed of events) {
        const next = {
          ...feed,
          creatorFeedSigner: keys.feedSigner.address as typeof feed.creatorFeedSigner,
          ...(feed.encryptionKeyRef !== undefined ? { encryptionKeyRef: keys.orderKeyRef } : {}),
        };
        await signEventFeedSoc(next, keys.feedSigner, undefined, keys.orderKeyRef);
        progress(++done, events.length);
      }
    },

    copySiteConfigs: async (keys) => {
      const [{ writeContentFeed }, { siteConfigTopic }, { feedRouteFor, ETHERNA_GATEWAY_URL }] = await Promise.all([
        import("../swarm/content-feed.js"),
        import("@woco/shared"),
        import("../swarm/gateways.js"),
      ]);
      for (const entry of await ownSites()) {
        const site = await ownSiteConfig(entry.siteId, h.oldSigner.address);
        await writeContentFeed({
          signerPrivKey: keys.feedSigner.privKey,
          topic: siteConfigTopic(entry.siteId),
          data: { ...site, updatedAt: Date.now() },
          route: feedRouteFor(ETHERNA_GATEWAY_URL),
        });
      }
    },

    copyProfile: async (keys) => {
      const [{ readContentFeed, writeContentFeed }, { FEED_ROUTES }, { profileDataContentTopic, profileAvatarContentTopic }] = await Promise.all([
        import("../swarm/content-feed.js"),
        import("../swarm/gateways.js"),
        import("@woco/shared"),
      ]);
      const route = FEED_ROUTES.profile;
      for (const topic of [profileDataContentTopic(parent), profileAvatarContentTopic(parent)]) {
        const data = await readContentFeed<unknown>(h.oldSigner.address, topic, { route });
        if (data) await writeContentFeed({ signerPrivKey: keys.feedSigner.privKey, topic, data, route });
      }
    },

    storeRing: async ({ gen, secret, prevRing, members }) => {
      const [{ buildKeyRing, NO_RING }, { storeKeyRing }, { accountKeysOf }] = await Promise.all([
        import("@woco/shared/keyring/ring"),
        import("./members.js"),
        import("@woco/shared/keyring/account-secret"),
      ]);
      const prior: (Uint8Array | null)[] = [bytes(h.seed)];
      for (let g = 1; g < gen; g++) {
        const s = h.chain?.secrets[g - 1] ?? "";
        prior.push(s ? bytes(s) : null);
      }
      const secretBytes = bytes(secret);
      try {
        const ring = await buildKeyRing({
          parent,
          gen,
          prev: prevRing ? `0x${prevRing}` : NO_RING,
          secret: secretBytes,
          prior: prior.slice(0, gen),
          members,
        });
        return await storeKeyRing(ring, accountKeysOf(secretBytes).orderKey.publicKey);
      } finally {
        secretBytes.fill(0);
        for (const p of prior) p?.fill(0);
      }
    },

    flip: (going, ring) => h.flip(going, ring),
    adopt: (chain) => h.adopt(chain),

    after: {
      server: async (_keys: NewKeys, ctx: { ring: string }) => {
        const { authPost } = await import("../api/client.js");
        const res = await authPost<{ ref: string; gen: number } | null>("/api/keyring/refresh", {});
        if (!res.ok) throw new Error(res.error ?? "refresh failed");
        // Told only when it names the ring just set - else it is retried at the next open.
        if (res.data?.ref !== ctx.ring) throw new Error("the server has not seen the new keys yet");
      },
      sites: async (keys: NewKeys) => {
        const [{ getSiteEvents, publishSite, deploySite }, { ETHERNA_GATEWAY_URL }] = await Promise.all([
          import("../api/sites.js"),
          import("../swarm/gateways.js"),
        ]);
        for (const entry of await ownSites()) {
          // Our own copy under the new signer - nobody else can have written it.
          const site = await ownSiteConfig(entry.siteId, keys.feedSigner.address);
          const events = await getSiteEvents(entry.siteId);
          if (!events.ok) throw new Error(`site ${entry.siteId} events unreadable`);
          const pub = await publishSite(site, events.data?.events ?? [], keys.feedSigner, ETHERNA_GATEWAY_URL);
          if (!pub.ok) throw new Error(pub.error ?? `site ${entry.siteId} not republished`);
          const dep = await deploySite(
            entry.siteId,
            { apiUrl: API_URL, gatewayUrl: ETHERNA_GATEWAY_URL, wocoAppUrl: WOCO_APP_URL, site },
            keys.feedSigner,
          );
          if (!dep.ok || !dep.data) throw new Error(dep.error ?? `site ${entry.siteId} not redeployed`);
          // deploySite signs the pointer-feed update itself, under the key it was given.
          await repoint(site.subEnsLabel, dep.data, !!dep.data.multisiteFeed, {
            owner: keys.feedSigner.address,
            topic: multisiteFeedTopic(entry.siteId),
          });
        }
      },
      pages: async (keys: NewKeys) => {
        const [{ deployEventPage }, { ETHERNA_GATEWAY_URL }] = await Promise.all([
          import("../api/sites.js"),
          import("../swarm/gateways.js"),
        ]);
        // Our own copies under the new signer: which events carry a name.
        for (const feed of await ownEvents(keys.feedSigner.address)) {
          if (!feed.subEnsLabel) continue;
          const e = feed;
          const dep = await deployEventPage(
            e.eventId,
            { apiUrl: API_URL, gatewayUrl: feed.gatewayUrl ?? ETHERNA_GATEWAY_URL, subEnsLabel: feed.subEnsLabel },
            keys.feedSigner,
          );
          if (!dep.ok || !dep.data) throw new Error(dep.error ?? `page ${e.eventId} not redeployed`);
          await repoint(feed.subEnsLabel, dep.data, dep.feedSigned && dep.data.feedOwner === "client", {
            owner: keys.feedSigner.address,
            topic: eventPageFeedTopic(e.eventId),
          });
        }
      },
      list: async (keys: NewKeys) => {
        const [{ getMarketingList, uploadMarketingList }, { listSealContext, sealBoxJsonCompressed }, { orderKeysOf, openJsonWithAnyKey }] =
          await Promise.all([import("../api/marketing.js"), import("@woco/shared/crypto/sealed-box"), import("./order-keys.js")]);
        const resp = await getMarketingList();
        if (!resp?.sealedList) return;
        const ctx = listSealContext(parent);
        const { secretKeys } = await orderKeysOf({ current: h.oldSecrets.at(-1)!, all: h.oldSecrets });
        const payload = await openJsonWithAnyKey<{ version: 1; contacts: { email: string }[] }>(secretKeys, resp.sealedList, ctx);
        const sealed = await sealBoxJsonCompressed(keys.orderPublicKey, payload, ctx);
        await uploadMarketingList(sealed, payload.contacts.map((c) => c.email));
      },
      // The removed passkeys' device records, off the list first (#746 order) - the
      // flip already did that.
      records: async (_keys: NewKeys, { going }) => {
        for (const key of going) await h.removeRecord(key);
      },
      social: async (keys: NewKeys) => {
        const { liveSocialDeps } = await import("../auth/upgrade-to-passkey-live.js");
        const social = await liveSocialDeps();
        for (const kind of ["like", "follow"] as const) {
          const subjects = await social.readLive(h.oldSigner.address, kind);
          if (subjects === "unavailable") throw new Error(`${kind}s unreadable`);
          for (const subject of subjects) {
            if (!(await social.write(keys.feedSigner, kind, subject, true))) throw new Error(`${kind} not moved`);
          }
        }
      },
    },
    progress: (p) => h.progress(p),
  };
}
