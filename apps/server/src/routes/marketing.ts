/**
 * /api/marketing — organiser audience (marketing list) endpoints.
 *
 * Trust model: the contact list is ECIES-sealed to the organiser's own X25519
 * key IN THE BROWSER. The server stores the sealed blob on Swarm (erasure
 * coding STRONG) plus HMAC email hashes for dedupe/suppression — plaintext
 * emails transit only the import/check/broadcast request bodies and are
 * hashed-and-discarded.
 *
 * Suppression is re-checked server-side on EVERY broadcast regardless of what
 * the client filtered (the client filter is UX; this is the guarantee).
 */

import { Hono } from "hono";
import { RedundancyLevel } from "@ethersphere/bee-js";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { hashEmail } from "../lib/event/claim-service.js";
import { getList, putList, withOrgLock } from "../lib/marketing/list-store.js";
import { suppressedSubset, suppressOrg } from "../lib/marketing/suppression-store.js";
import { capRemaining, recordSend } from "../lib/marketing/send-cap.js";
import { sendMarketingBatch } from "../lib/email/marketing-send.js";
import { getResend, getMarketingFromAddress } from "../lib/email/client.js";
import { uploadToBytes, downloadFromBytes } from "../lib/swarm/bytes.js";
import { writeFeedPage, encodeJsonFeed } from "../lib/swarm/feeds.js";
import { topicMarketingList } from "../lib/swarm/topics.js";

const marketing = new Hono<AppEnv>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LIST_EMAILS = 20_000;
/** Hex ciphertext ≈ 2× plaintext, so this is roughly a 3MB plaintext list. */
const MAX_SEALED_JSON = 6_000_000;
const MAX_BROADCAST_RECIPIENTS = 1000;

/** Marketing broadcast rate limit: 2/hour per organiser. */
const broadcastRateMap = new Map<string, number[]>();
const BROADCAST_RATE_LIMIT = 2;
const BROADCAST_RATE_WINDOW = 3_600_000;

interface SealedBoxShape {
  ephemeralPublicKey: string;
  iv: string;
  ciphertext: string;
}

function isSealedBox(v: unknown): v is SealedBoxShape {
  if (!v || typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b.ephemeralPublicKey === "string" &&
    typeof b.iv === "string" &&
    typeof b.ciphertext === "string"
  );
}

function normalizeEmails(raw: unknown, max: number): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > max) return null;
  const out: string[] = [];
  for (const e of raw) {
    if (typeof e !== "string") return null;
    const norm = e.trim().toLowerCase();
    if (!EMAIL_RE.test(norm)) return null;
    out.push(norm);
  }
  return out;
}

/** Replace the organiser's stored list (sealed blob + hashes). */
marketing.post("/list", requireAuth, async (c) => {
  const org = c.get("parentAddress").toLowerCase();
  const body = c.get("body") as Record<string, unknown>;

  try {
    const sealedList = body.sealedList;
    if (!isSealedBox(sealedList)) {
      return c.json({ ok: false, error: "sealedList must be a SealedBox" }, 400);
    }
    if (JSON.stringify(sealedList).length > MAX_SEALED_JSON) {
      return c.json({ ok: false, error: "Sealed list too large (max ~20k contacts)" }, 413);
    }
    const emails = normalizeEmails(body.emails, MAX_LIST_EMAILS);
    if (!emails) {
      return c.json({ ok: false, error: `emails must be 1..${MAX_LIST_EMAILS} valid addresses` }, 400);
    }

    const data = await withOrgLock(org, async () => {
      const emailHashes = [...new Set(emails.map(hashEmail))];
      const swarmRef = await uploadToBytes(JSON.stringify(sealedList), undefined, {
        redundancyLevel: RedundancyLevel.STRONG,
      });
      const updatedAt = new Date().toISOString();
      const count = emailHashes.length;
      await writeFeedPage(
        topicMarketingList(org),
        encodeJsonFeed({ version: 1, swarmRef, count, updatedAt }),
      );
      putList(org, { swarmRef, count, updatedAt, emailHashes });
      return { swarmRef, count, updatedAt };
    });

    return c.json({ ok: true, data });
  } catch (err) {
    console.error("[marketing] list upload error:", err);
    const message = err instanceof Error ? err.message : "List upload failed";
    return c.json({ ok: false, error: message }, 500);
  }
});

/** Fetch the stored list: meta + sealed blob (server passthrough from Swarm). */
marketing.get("/list", requireAuth, async (c) => {
  const org = c.get("parentAddress").toLowerCase();
  try {
    const entry = getList(org);
    if (!entry) return c.json({ ok: true, data: null });

    const sealedList = JSON.parse(await downloadFromBytes(entry.swarmRef)) as SealedBoxShape;
    return c.json({
      ok: true,
      data: {
        meta: { count: entry.count, updatedAt: entry.updatedAt, swarmRef: entry.swarmRef },
        sealedList,
      },
    });
  } catch (err) {
    console.error("[marketing] list fetch error:", err);
    const message = err instanceof Error ? err.message : "List fetch failed";
    return c.json({ ok: false, error: message }, 500);
  }
});

/** Import-wizard validation: which of these emails are suppressed / already stored? */
marketing.post("/check", requireAuth, async (c) => {
  const org = c.get("parentAddress").toLowerCase();
  const body = c.get("body") as Record<string, unknown>;

  const emails = normalizeEmails(body.emails, MAX_LIST_EMAILS);
  if (!emails) {
    return c.json({ ok: false, error: `emails must be 1..${MAX_LIST_EMAILS} valid addresses` }, 400);
  }

  const hashToEmail = new Map<string, string>();
  for (const e of emails) hashToEmail.set(hashEmail(e), e);
  const hashes = [...hashToEmail.keys()];

  const suppressedHashes = new Set(suppressedSubset(org, hashes));
  const storedHashes = new Set(getList(org)?.emailHashes ?? []);

  const suppressed: string[] = [];
  const alreadyInList: string[] = [];
  for (const [h, e] of hashToEmail) {
    if (suppressedHashes.has(h)) suppressed.push(e);
    if (storedHashes.has(h)) alreadyInList.push(e);
  }

  return c.json({ ok: true, data: { suppressed, alreadyInList } });
});

/** Manual per-organiser suppression (contact delete + "also unsubscribe"). */
marketing.post("/suppress", requireAuth, async (c) => {
  const org = c.get("parentAddress").toLowerCase();
  const body = c.get("body") as Record<string, unknown>;

  const emails = normalizeEmails(body.emails, 1000);
  if (!emails) {
    return c.json({ ok: false, error: "emails must be 1..1000 valid addresses" }, 400);
  }
  for (const e of emails) suppressOrg(hashEmail(e), org, "manual");
  return c.json({ ok: true, data: { suppressed: emails.length } });
});

/** Marketing broadcast to client-decrypted recipients. */
marketing.post("/broadcast", requireAuth, async (c) => {
  const org = c.get("parentAddress").toLowerCase();
  const body = c.get("body") as Record<string, unknown>;

  try {
    try { getResend(); } catch {
      return c.json({ ok: false, error: "Email not configured (RESEND_API_KEY missing)" }, 500);
    }

    const fromName = body.fromName as string;
    const subject = body.subject as string;
    const htmlBody = body.htmlBody as string;
    const recipients = body.recipients as Array<{ email: string; name?: string }>;

    if (!fromName || typeof fromName !== "string" || fromName.length > 100) {
      return c.json({ ok: false, error: "fromName required (max 100 chars)" }, 400);
    }
    if (!subject || typeof subject !== "string" || subject.length > 200) {
      return c.json({ ok: false, error: "Subject required (max 200 chars)" }, 400);
    }
    if (!htmlBody || typeof htmlBody !== "string" || htmlBody.length > 50_000) {
      return c.json({ ok: false, error: "Body required (max 50KB)" }, 400);
    }
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return c.json({ ok: false, error: "At least one recipient required" }, 400);
    }
    if (recipients.length > MAX_BROADCAST_RECIPIENTS) {
      return c.json({ ok: false, error: `Maximum ${MAX_BROADCAST_RECIPIENTS} recipients per broadcast` }, 400);
    }
    for (const r of recipients) {
      if (!r?.email || typeof r.email !== "string" || !EMAIL_RE.test(r.email)) {
        return c.json({ ok: false, error: `Invalid email: ${String(r?.email)}` }, 400);
      }
    }

    // Rate limit: 2 marketing broadcasts per hour per organiser
    const now = Date.now();
    const timestamps = broadcastRateMap.get(org) ?? [];
    const recent = timestamps.filter((t) => now - t < BROADCAST_RATE_WINDOW);
    if (recent.length >= BROADCAST_RATE_LIMIT) {
      return c.json({ ok: false, error: "Rate limit exceeded (2 marketing broadcasts per hour)" }, 429);
    }

    // Daily cap: explicit reject, never silent trimming
    const remaining = capRemaining(org);
    if (recipients.length > remaining) {
      return c.json(
        { ok: false, error: `Daily marketing send cap reached (${remaining} of your daily allowance remaining). Try a smaller batch or wait.` },
        429,
      );
    }

    const result = await sendMarketingBatch({
      organiserAddress: org,
      fromDisplayName: fromName,
      fromAddress: getMarketingFromAddress(),
      subject,
      html: htmlBody,
      recipients,
    });

    recent.push(now);
    broadcastRateMap.set(org, recent);
    recordSend(org, result.sent);

    console.log(
      `[marketing] broadcast org=${org} sent=${result.sent} suppressed=${result.suppressed} failed=${result.failed}`,
    );

    return c.json({
      ok: true,
      data: {
        sent: result.sent,
        suppressed: result.suppressed,
        failed: result.failed,
        capRemaining: capRemaining(org),
        ...(result.errors.length > 0 ? { errors: result.errors.slice(0, 10) } : {}),
      },
    });
  } catch (err) {
    console.error("[marketing] broadcast error:", err);
    const message = err instanceof Error ? err.message : "Broadcast failed";
    return c.json({ ok: false, error: message }, 500);
  }
});

export { marketing };
