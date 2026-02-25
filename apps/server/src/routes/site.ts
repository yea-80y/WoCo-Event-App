import { Hono } from "hono";
import { Topic, Reference } from "@ethersphere/bee-js";
import {
  getBee,
  getPlatformSigner,
  getPlatformOwner,
  requirePostageBatch,
  BEE_URL,
} from "../config/swarm.js";
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

site.post("/deploy", async (c) => {
  let tmpDir: string | null = null;
  let tarPath: string | null = null;

  try {
    const body = await c.req.json() as {
      eventId: string;
      gatewayUrl?: string;
      paraApiKey?: string;
      apiUrl: string;
    };
    const { eventId, gatewayUrl, paraApiKey, apiUrl } = body;

    if (!eventId || !apiUrl) {
      return c.json({ ok: false, error: "eventId and apiUrl are required" }, 400);
    }

    if (!existsSync(DIST_SITE_PATH)) {
      return c.json({
        ok: false,
        error:
          "Site template not found on server. Run `npm run build:site` locally then " +
          "rsync apps/web/dist-site/ to the server.",
      }, 503);
    }

    const batchId = requirePostageBatch();
    const signer = getPlatformSigner();
    const owner = getPlatformOwner();
    const bee = getBee();

    // 1) Read site.html and inject runtime config before </head>
    const siteHtmlPath = join(DIST_SITE_PATH, "site.html");
    const siteHtml = await fs.readFile(siteHtmlPath, "utf-8");

    const config = {
      apiUrl,
      gatewayUrl: gatewayUrl?.trim() || "https://gateway.ethswarm.org",
      eventId,
      ...(paraApiKey?.trim() ? { paraApiKey: paraApiKey.trim() } : {}),
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

    // 4) Upload directory to Swarm as a collection
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
    });

    if (!uploadResp.ok) {
      const text = await uploadResp.text().catch(() => "");
      throw new Error(`Swarm upload failed ${uploadResp.status}: ${text.slice(0, 300)}`);
    }

    const { reference: contentHash } = await uploadResp.json() as { reference: string };

    // 5) Per-event feed topic so each event gets its own updatable ENS entry
    const topic = Topic.fromString(`woco-site-${eventId}`);

    // Create feed manifest (one-time; if it already exists the call still succeeds)
    let feedManifestHash = "";
    try {
      const mRef = await bee.createFeedManifest(batchId, topic, owner);
      feedManifestHash = mRef.toString();
    } catch {
      // Non-fatal — organiser can still use the direct content hash
    }

    // 6) Update feed → new content hash
    const writer = bee.makeFeedWriter(topic, signer);
    await writer.upload(batchId, new Reference(contentHash));

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
