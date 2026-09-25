import { Hono } from "hono";
import { Topic } from "@ethersphere/bee-js";
import { eventPageFeedTopic, validateLabel } from "@woco/shared";
import { requireAuth } from "../middleware/auth.js";
import { eventPageDeployGate } from "../lib/event/page-deploy-gate.js";
import {
  batchForDeploy,
  BatchPurchaseRequired,
  PlatformBatchUnavailable,
  ETHERNA_URL,
  isEthernaGateway,
} from "../lib/etherna/batch-router.js";
import { recordUpload } from "../lib/swarm/storage-ledger.js";
import { whitelistHashes } from "../lib/swarm/whitelist.js";
import { uploadCollectionToEtherna, registerEthernaOffer, prepareEthernaFeedUpdate } from "../lib/etherna/upload.js";
import { checkSiteSubEns, type SiteDeploySubEns } from "../lib/sub-ens/site-pointer.js";
import {
  injectBeforeHeadClose,
  isSafeIdParam,
  siteConfigScript,
  resolveDeployApiUrl,
} from "../lib/site/deploy-config.js";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const site = new Hono();

const __dirname = dirname(fileURLToPath(import.meta.url));

// dist-site lives alongside the server source once rsynced.
// Path from apps/server/src/routes/ → project root → apps/web/dist-site
const DIST_SITE_PATH = resolve(__dirname, "../../../../apps/web/dist-site");

// ── Helpers ────────────────────────────────────────────────────────────────

function spawnPromise(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) res();
      else rej(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 300)}`));
    });
    proc.on("error", rej);
  });
}

// ── POST /api/site/deploy ──────────────────────────────────────────────────

site.post("/deploy", requireAuth, async (c) => {
  let tmpDir: string | null = null;
  let tarPath: string | null = null;

  try {
    const parentAddress = (c.get("parentAddress") as string).toLowerCase();

    const body = await c.req.json() as {
      eventId: string;
      gatewayUrl?: string;
      apiUrl: string;
      /** The browser will sign the page-feed update (#614); absent = no feed. */
      clientFeed?: boolean;
      /** A name to check against the page feed - read-only, never written here. */
      subEnsLabel?: string;
    };
    const { eventId, gatewayUrl, apiUrl: clientApiUrl, subEnsLabel } = body;

    // eventId is interpolated into the deployed page's SITE_CONFIG, so its shape
    // is a security property, not just hygiene: the charset admits no `<`, `>`,
    // quote or slash, which holds even if the escaping below is ever bypassed
    // (#193).
    if (!eventId || !isSafeIdParam(eventId)) {
      return c.json({ ok: false, error: "eventId is missing or malformed" }, 400);
    }

    // The API base every authenticated request from the deployed page is sent to.
    // Taken from the server's own PUBLIC_API_BASE and the client's claim
    // discarded — `sanitisePublicApiUrl` only rejected private/non-https hosts,
    // so it admitted any https host the organiser chose, which would have
    // received visitors' session delegation and signature headers (#193).
    const apiUrl = resolveDeployApiUrl(clientApiUrl);
    if (!apiUrl) {
      return c.json({
        ok: false,
        error: "apiUrl is required and PUBLIC_API_BASE is not configured on the server",
      }, 400);
    }

    // Event pages are stored on Etherna only (#617): its feed is the organiser's
    // and Etherna is where the browser signs it into. Absent means Etherna.
    if (gatewayUrl?.trim() && !isEthernaGateway(gatewayUrl)) {
      return c.json({ ok: false, error: "Event pages are published on Etherna" }, 400);
    }
    if (subEnsLabel !== undefined && (typeof subEnsLabel !== "string" || validateLabel(subEnsLabel))) {
      return c.json({ ok: false, error: "subEnsLabel is not a valid name" }, 400);
    }

    // Only the event's creator publishes its page (#679), and the page feed is
    // owned by the signer pinned at create (#676) - never a request value.
    const gate = eventPageDeployGate(eventId, parentAddress);
    if (!gate.ok) return c.json({ ok: false, error: gate.error }, gate.status);

    if (!existsSync(DIST_SITE_PATH)) {
      return c.json({
        ok: false,
        error:
          "Site template not found on server. Run `npm run build:site` locally then " +
          "rsync apps/web/dist-site/ to the server.",
      }, 503);
    }

    let selection;
    try {
      selection = batchForDeploy({
        ownerAddress: parentAddress,
        gatewayUrl: ETHERNA_URL,
        deployType: "event",
      });
    } catch (err) {
      if (err instanceof BatchPurchaseRequired) {
        return c.json({ ok: false, error: err.message, code: "BATCH_PURCHASE_REQUIRED" }, 402);
      }
      if (err instanceof PlatformBatchUnavailable) return c.json({ ok: false, error: err.message, code: err.code }, 503);
      throw err;
    }
    const { batchId, target } = selection;
    // The route above only ever asks for Etherna; anything else is a router bug.
    if (target !== "etherna") throw new Error(`event page routed to ${target}, expected etherna`);

    // 1) Read site.html and inject runtime config before </head>
    const siteHtmlPath = join(DIST_SITE_PATH, "site.html");
    const siteHtml = await fs.readFile(siteHtmlPath, "utf-8");

    // Phase B carrier: bake the event's content-feed signer into SITE_CONFIG so the
    // deployed page reads GET /api/events/:id?signer=… and the server reads the
    // client-signed SOC directly - an unlisted event is in no directory. From the
    // record pinned at create, the same source as the feed owner below (#676).
    const eventSigner = gate.signer;

    const config = {
      apiUrl,
      gatewayUrl: ETHERNA_URL,
      // Event images (uploaded to WoCo Bee at event-creation time) must always
      // be fetched from the WoCo gateway, regardless of where the site is hosted.
      contentGatewayUrl: "https://gateway.woco-net.com",
      eventId,
      eventSigner,
    };
    const configScript = siteConfigScript(config);
    const injectedHtml = injectBeforeHeadClose(siteHtml, `  ${configScript}`);

    // 2) Copy dist-site to a temp dir, write modified site.html
    const ts = Date.now();
    tmpDir = `/tmp/woco-site-${ts}`;
    tarPath = `/tmp/woco-site-${ts}.tar`;

    await fs.cp(DIST_SITE_PATH, tmpDir, { recursive: true });
    await fs.writeFile(join(tmpDir, "site.html"), injectedHtml, "utf-8");

    // 3) Create tar (system tar is always available on Linux)
    await spawnPromise("tar", ["-cf", tarPath, "-C", tmpDir, "."]);
    const tarData = await fs.readFile(tarPath);

    // 4) Upload the page to Etherna as a collection
    const contentHash = await uploadCollectionToEtherna({
      batchId,
      tarData,
      indexDocument: "site.html",
    });
    // Make anonymously readable via /bytes and /bzz/{ref}/file
    await registerEthernaOffer(contentHash);

    // Event pages are exempt from the free-hosting gate (publishing an event must
    // never block on it) but their bytes still land in the ledger — it is the
    // capacity meter and the per-owner migration manifest for ALL hosted content.
    recordUpload(parentAddress, {
      ref: contentHash,
      bytes: tarData.length,
      kind: "event-site-deploy",
      batchId,
      target,
      note: eventId,
    });

    // 5) The page's feed is the ORGANISER's (#614): owned by the signer pinned at
    // create and signed in the browser, so no key but theirs can change what a
    // name following it shows. The platform never writes one - it used to, and
    // with no creator check any account could advance it (#679). A client that
    // cannot sign gets no feed at all, never a platform one. Same steps as a
    // client-owned site (sites.ts), on the content's batch (#48).
    let feedManifestHash = "";
    let pageFeed: { owner: string; nextIndex: number; rootChunkPayloadB64: string } | undefined;
    if (body.clientFeed === true) {
      const prep = await prepareEthernaFeedUpdate({
        topic: Topic.fromString(eventPageFeedTopic(eventId)),
        contentHash,
        batchId,
        ownerHex: gate.signer.replace(/^0x/, ""),
      });
      feedManifestHash = prep.feedManifestHash;
      // The owner travels with the update so the browser refuses to sign a feed
      // it does not own; the span is stripped because the signer re-derives it.
      pageFeed = {
        owner: gate.signer,
        nextIndex: Number(prep.nextIndex),
        rootChunkPayloadB64: Buffer.from(prep.chunkBytes.subarray(8)).toString("base64"),
      };
      // Etherna answers 402 to an anonymous /bzz/{manifest}/ without an offer.
      void registerEthernaOffer(feedManifestHash).catch((e) =>
        console.warn("[site/deploy] etherna feed-manifest offer failed (non-fatal):", e));
    }

    // Does the name already follow this feed? Read-only chain state, so the
    // builder asks for a pointer signature only the first time (#614).
    let subEns: SiteDeploySubEns | undefined;
    if (subEnsLabel && feedManifestHash) {
      subEns = await checkSiteSubEns(subEnsLabel, parentAddress, feedManifestHash, "client");
    }

    // Whitelist the page and its feed on our gateway, as the site deploy does
    // (sites.ts). Without it our gateway refuses an event page outright - 403
    // for `eventtest` on 2026-09-21 - so only other people's nodes can serve
    // the organiser's own page (#613). Fire-and-forget: a whitelist failure
    // must not fail a deploy that has already landed.
    void whitelistHashes([contentHash, feedManifestHash].filter(Boolean)).catch((e) =>
      console.warn("[site/deploy] whitelist call failed:", e),
    );

    return c.json({
      ok: true,
      data: {
        contentHash,
        feedManifestHash,
        ...(pageFeed ? { feedOwner: "client" as const, pageFeed } : {}),
        ...(subEns ? { subEns } : {}),
      },
    });

  } catch (e) {
    console.error("[site/deploy]", e);
    return c.json({
      ok: false,
      error: e instanceof Error ? e.message : "Deploy failed",
    }, 500);

  } finally {
    // Best-effort cleanup of temp files
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    if (tarPath) await fs.unlink(tarPath).catch(() => {});
  }
});

export { site as siteRoute };
