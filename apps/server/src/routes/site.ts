import { Hono } from "hono";
import { Topic, Reference } from "@ethersphere/bee-js";
import {
  getBee,
  getPlatformSigner,
  getPlatformOwner,
  POSTAGE_BATCH_ID,
  BEE_URL,
} from "../config/swarm.js";
import { requireAuth } from "../middleware/auth.js";
import { getCreatorEvents } from "../lib/event/service.js";
import { batchForDeploy, BatchPurchaseRequired } from "../lib/etherna/batch-router.js";
import { recordUpload } from "../lib/swarm/storage-ledger.js";
import { getEthernaBee, uploadCollectionToEtherna, registerEthernaOffer } from "../lib/etherna/upload.js";
import { BEE_CALL_TIMEOUT_MS, BEE_COLLECTION_TIMEOUT_MS, withTimeout } from "../lib/swarm/upload-queue.js";
import { sanitisePublicApiUrl } from "../lib/url/public-api-url.js";
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
    };
    const { eventId, gatewayUrl, apiUrl: clientApiUrl } = body;

    if (!eventId) {
      return c.json({ ok: false, error: "eventId is required" }, 400);
    }

    // Substitute the server's own PUBLIC_API_BASE for any localhost / private /
    // non-https value the client supplied. Without this, sites deployed from
    // a local dev frontend bake `http://localhost:3001` into SITE_CONFIG and
    // visitors on the public internet can't reach the API.
    const apiUrl = sanitisePublicApiUrl(clientApiUrl);
    if (!apiUrl) {
      return c.json({
        ok: false,
        error: "apiUrl is required and PUBLIC_API_BASE is not configured on the server",
      }, 400);
    }

    if (!existsSync(DIST_SITE_PATH)) {
      return c.json({
        ok: false,
        error:
          "Site template not found on server. Run `npm run build:site` locally then " +
          "rsync apps/web/dist-site/ to the server.",
      }, 503);
    }

    const effectiveGateway = gatewayUrl?.trim() || "https://gateway.etherna.io";
    let selection;
    try {
      selection = batchForDeploy({
        ownerAddress: parentAddress,
        gatewayUrl: effectiveGateway,
        deployType: "event",
      });
    } catch (err) {
      if (err instanceof BatchPurchaseRequired) {
        return c.json({ ok: false, error: err.message, code: "BATCH_PURCHASE_REQUIRED" }, 402);
      }
      throw err;
    }
    const { batchId, target } = selection;
    const signer = getPlatformSigner();
    const owner = getPlatformOwner();
    const bee = target === "etherna" ? getEthernaBee() : getBee();

    // 1) Read site.html and inject runtime config before </head>
    const siteHtmlPath = join(DIST_SITE_PATH, "site.html");
    const siteHtml = await fs.readFile(siteHtmlPath, "utf-8");

    // Phase B carrier: bake the event's content-feed signer into SITE_CONFIG so the
    // deployed page reads GET /api/events/:id?signer=… and the server reads the
    // client-signed SOC directly. Without it an unlisted (skipAutoList) event can't
    // be resolved — it isn't in the global directory — and the page fails to load.
    // The deployer IS the owner, so their creator directory holds the carrier.
    let eventSigner: string | undefined;
    try {
      const creatorEvents = await getCreatorEvents(parentAddress);
      eventSigner = creatorEvents.find((e) => e.eventId === eventId)?.creatorFeedSigner;
    } catch {
      // Non-fatal: legacy/platform-signed events have no carrier and resolve via the directory.
    }

    const config = {
      apiUrl,
      gatewayUrl: gatewayUrl?.trim() || "https://gateway.woco-net.com",
      // Event images (uploaded to WoCo Bee at event-creation time) must always
      // be fetched from the WoCo gateway, regardless of where the site is hosted.
      contentGatewayUrl: "https://gateway.woco-net.com",
      eventId,
      ...(eventSigner ? { eventSigner } : {}),
    };
    const configScript = `<script>window.SITE_CONFIG=${JSON.stringify(config)};</script>`;
    const injectedHtml = siteHtml.replace("</head>", `  ${configScript}\n  </head>`);

    // 2) Copy dist-site to a temp dir, write modified site.html
    const ts = Date.now();
    tmpDir = `/tmp/woco-site-${ts}`;
    tarPath = `/tmp/woco-site-${ts}.tar`;

    await fs.cp(DIST_SITE_PATH, tmpDir, { recursive: true });
    await fs.writeFile(join(tmpDir, "site.html"), injectedHtml, "utf-8");

    // 3) Create tar (system tar is always available on Linux)
    await spawnPromise("tar", ["-cf", tarPath, "-C", tmpDir, "."]);
    const tarData = await fs.readFile(tarPath);

    // 4) Upload directory to Swarm as a collection — branch by target
    let contentHash: string;
    if (target === "etherna") {
      contentHash = await uploadCollectionToEtherna({
        batchId,
        tarData,
        indexDocument: "site.html",
      });
      // Make anonymously readable via /bytes and /bzz/{ref}/file
      await registerEthernaOffer(contentHash);
    } else {
      const uploadResp = await fetch(`${BEE_URL}/bzz`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-tar",
          "Swarm-Postage-Batch-Id": batchId,
          "Swarm-Index-Document": "site.html",
          "Swarm-Error-Document": "site.html",
          "Swarm-Collection": "true",
        },
        // @ts-ignore — Node 18 fetch doesn't expose duplex in type defs
        duplex: "half",
        body: tarData,
        signal: AbortSignal.timeout(BEE_COLLECTION_TIMEOUT_MS),
      });

      if (!uploadResp.ok) {
        const text = await uploadResp.text().catch(() => "");
        throw new Error(`Swarm upload failed ${uploadResp.status}: ${text.slice(0, 300)}`);
      }

      ({ reference: contentHash } = await uploadResp.json() as { reference: string });
    }

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

    // 5) Per-event feed topic so each event gets its own updatable ENS entry.
    // The feed index always lives on the WoCo Bee — bee-js v11's onRequest
    // auth injection is unreliable for SOC writes, and this is a WoCo platform
    // feed regardless of where the content was uploaded.
    const topic = Topic.fromString(`woco-site-${eventId}`);
    const platformBee = getBee();

    // Create feed manifest (one-time; if it already exists the call still succeeds)
    let feedManifestHash = "";
    try {
      const mRef = await withTimeout(
        platformBee.createFeedManifest(POSTAGE_BATCH_ID, topic, owner),
        BEE_CALL_TIMEOUT_MS,
        "site feed manifest",
      );
      feedManifestHash = mRef.toString();
    } catch {
      // Non-fatal — organiser can still use the direct content hash
    }

    // 6) Update feed → new content hash
    const writer = platformBee.makeFeedWriter(topic, signer);
    await withTimeout(
      writer.upload(POSTAGE_BATCH_ID, new Reference(contentHash)),
      BEE_CALL_TIMEOUT_MS,
      "site feed write",
    );

    return c.json({ ok: true, data: { contentHash, feedManifestHash } });

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
