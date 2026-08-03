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
import type { MiddlewareHandler } from "hono";
import { RedundancyLevel } from "@ethersphere/bee-js";
import { FEATURES, MAILABLE_EMAIL_RE, MARKETING_MAX_LIST_EMAILS } from "@woco/shared";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { isVerifiedOrganiser } from "../lib/stripe/verification.js";
import { hashEmail } from "../lib/event/claim-service.js";
import { getList, putList, withOrgLock } from "../lib/marketing/list-store.js";
import { normalizeEmails } from "../lib/marketing/emails.js";
import { suppressedSubset, suppressOrg } from "../lib/marketing/suppression-store.js";
import { consentedSubset } from "../lib/marketing/consent-store.js";
import { capRemaining, recordSend } from "../lib/marketing/send-cap.js";
import { sendMarketingBatch } from "../lib/email/marketing-send.js";
import { getResend, getMarketingFromAddress } from "../lib/email/client.js";
import {
  getDomain,
  putDomain,
  deleteDomain,
  resolveMarketingFrom,
  MARKETING_SENDER_UNCONFIGURED,
  MARKETING_SENDER_UNCONFIGURED_CODE,
  type SendingDomainEntry,
} from "../lib/marketing/sending-domain-store.js";
import { uploadToBytes, downloadFromBytes } from "../lib/swarm/bytes.js";
import { writeFeedPage, encodeJsonFeed } from "../lib/swarm/feeds.js";
import { topicMarketingList } from "../lib/swarm/topics.js";

const marketing = new Hono<AppEnv>();

/**
 * Custom sending domains are gated by FEATURES.organiserSendingDomains, in
 * lockstep with the UI — hiding the panel alone would leave the endpoints
 * reachable by an older client or a direct call, and every one of them either
 * 401s against the send-only Resend key or burns a slot on the Pro domain cap
 * that SES migration would then have to undo (PRICING_AND_EMAIL.md §6).
 */
const domainsGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!FEATURES.organiserSendingDomains) {
    return c.json(
      { ok: false, error: "Custom sending domains aren't available yet", code: "FEATURE_OFF" },
      403,
    );
  }
  await next();
};

const MAX_LIST_EMAILS = MARKETING_MAX_LIST_EMAILS;
/**
 * Hex ciphertext ≈ 2× plaintext, so this allows ~3MB of sealed bytes.
 *
 * The client gzips before sealing (`sealJsonCompressed`), which puts a full
 * 20k-contact list around 1MB sealed even with every optional field populated.
 * Uncompressed it would be ~8MB — i.e. this cap is a backstop against a runaway
 * blob, NOT the thing that makes a legitimate max-size list fit.
 */
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

/** Shape/size refusal — the one thing content-tolerant normalisation still rejects. */
function badShape(max: number): string {
  return `emails must be an array of at most ${max.toLocaleString()} addresses`;
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
    // An EMPTY array is a legitimate state, not malformed input: it is what
    // deleting the last contact looks like, and refusing it made "remove
    // everyone" impossible through the UI (#136) — an odd neighbour for the
    // erasure path. It stays distinguishable from never-having-imported, which
    // is `getList` returning null.
    const normalized = normalizeEmails(body.emails, MAX_LIST_EMAILS);
    if (!normalized) {
      return c.json({ ok: false, error: badShape(MAX_LIST_EMAILS) }, 400);
    }
    const { emails, unmailable, unmailableCount } = normalized;

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

    // Reported, never dropped. Excluding an unmailable row from the index would
    // desync it from the sealed blob the organiser can still see on screen, and
    // that index is what subject-access and erasure read.
    return c.json({
      ok: true,
      data: { ...data, ...(unmailableCount > 0 ? { unmailable, unmailableCount } : {}) },
    });
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

/** Which of these emails are suppressed / already stored / hold a consent record? */
marketing.post("/check", requireAuth, async (c) => {
  const org = c.get("parentAddress").toLowerCase();
  const body = c.get("body") as Record<string, unknown>;

  // A query, so an unmailable address gets a truthful answer (it is in none of
  // the three sets) rather than a 400 that takes the whole batch down with it.
  // That refusal is live today: `claims.ts` admits a claim address on
  // `includes("@")` alone, and one such buyer 400s an entire "Add from your
  // events" scan (AttendeeImport calls this before it can import anyone).
  const normalized = normalizeEmails(body.emails, MAX_LIST_EMAILS);
  if (!normalized) {
    return c.json({ ok: false, error: badShape(MAX_LIST_EMAILS) }, 400);
  }
  const { emails } = normalized;

  const hashToEmail = new Map<string, string>();
  for (const e of emails) hashToEmail.set(hashEmail(e), e);
  const hashes = [...hashToEmail.keys()];

  const suppressedHashes = new Set(suppressedSubset(org, hashes));
  const storedHashes = new Set(getList(org)?.emailHashes ?? []);
  // Returned so the audience UI can tell a contact who ticked the box at
  // checkout (evidence exists) from one imported under the organiser's own
  // warranty. Only the caller's OWN organiser scope is consulted, and only for
  // addresses they already hold — this cannot be used to probe whether someone
  // consented to a different organiser.
  const consentedHashes = new Set(consentedSubset(org, hashes));

  const suppressed: string[] = [];
  const alreadyInList: string[] = [];
  const consented: string[] = [];
  for (const [h, e] of hashToEmail) {
    if (suppressedHashes.has(h)) suppressed.push(e);
    if (storedHashes.has(h)) alreadyInList.push(e);
    if (consentedHashes.has(h)) consented.push(e);
  }

  return c.json({ ok: true, data: { suppressed, alreadyInList, consented } });
});

/** Manual per-organiser suppression (contact delete + "also unsubscribe"). */
marketing.post("/suppress", requireAuth, async (c) => {
  const org = c.get("parentAddress").toLowerCase();
  const body = c.get("body") as Record<string, unknown>;

  const normalized = normalizeEmails(body.emails, 1000);
  if (!normalized) {
    return c.json({ ok: false, error: badShape(1000) }, 400);
  }
  // Unlike `/list`, an EMPTY array here is a caller bug rather than a state:
  // there is no "suppress nobody" intent to honour. Unmailable addresses ARE
  // suppressed — the organiser asked for this contact to stay unsubscribed, and
  // a permanent mark on a hash nobody can mail costs nothing and honours it.
  const { emails } = normalized;
  if (emails.length === 0) {
    return c.json({ ok: false, error: "At least one address is required" }, 400);
  }
  for (const e of emails) suppressOrg(hashEmail(e), org, "manual");
  return c.json({ ok: true, data: { suppressed: emails.length } });
});

/** Abuse gate (#59): sending on WoCo's reputation requires a Stripe-verified
 *  organiser — same charges_enabled check as paid events and free hosting.
 *  Importing/reading the list stays open; only SENDING (and claiming Resend
 *  domain slots) is gated. Event broadcasts are deliberately NOT gated here:
 *  attendee-relationship mail (e.g. cancellations) must not depend on Stripe. */
async function requireVerifiedSender(org: string): Promise<Response | null> {
  if (await isVerifiedOrganiser(org)) return null;
  return Response.json(
    {
      ok: false,
      error: "Connect and verify a Stripe account to send marketing (free — it verifies your identity and protects everyone's deliverability)",
      code: "STRIPE_VERIFICATION_REQUIRED",
    },
    { status: 403 },
  );
}

/**
 * `POST /api/marketing/broadcast` — RETIRED.
 *
 * Marketing broadcasts now go through the background queue at
 * `/api/broadcasts/jobs` (`kind: "marketing"`). The gates moved with them
 * unchanged: Stripe-verified sender, imported-audience membership per recipient,
 * 2/hour, and the rolling daily cap. What did not move is sending inside the
 * HTTP request — at the account send rate a full-list broadcast takes ~28
 * minutes against a 125s origin timeout, and no send rate makes that fit.
 *
 * An explicit 410 rather than a deletion: Hono's default 404 is plain text, and
 * the frontend's `authPost` would surface it as a JSON parse error instead of
 * "reload the page".
 */
marketing.post("/broadcast", (c) =>
  c.json(
    {
      ok: false,
      error:
        "This page is out of date — reload it. Broadcasts now send in the background, " +
        "so your whole audience can be mailed in one go.",
      code: "BROADCAST_ENDPOINT_RETIRED",
    },
    410,
  ),
);

/** Test sends: enough to iterate on a draft, useless as a bulk sender. */
const testSendRateMap = new Map<string, number[]>();
const TEST_SEND_RATE_LIMIT = 5;

/**
 * Send the draft to one address the organiser types (their own inbox) before
 * committing to the whole audience — a broadcast cannot be recalled.
 *
 * There is deliberately NO imported-list membership check: the point is
 * previewing in an inbox that may not be in the audience. What keeps this from
 * becoming a send-to-anyone path instead: the Stripe-verified-sender gate, one
 * recipient per call, 5/hour, an unremovable "[Test]" subject prefix, and the
 * full compliance path (suppression + unsubscribe + footer) like any other send.
 * It does not consume the daily cap — iterating on a draft must not eat the
 * allowance the real broadcast needs.
 */
marketing.post("/broadcast/test", requireAuth, async (c) => {
  const org = c.get("parentAddress").toLowerCase();
  const body = c.get("body") as Record<string, unknown>;

  try {
    try { getResend(); } catch {
      return c.json({ ok: false, error: "Email not configured (RESEND_API_KEY missing)" }, 500);
    }

    const gate = await requireVerifiedSender(org);
    if (gate) return gate;

    const fromName = body.fromName as string;
    const subject = body.subject as string;
    const htmlBody = body.htmlBody as string;
    const email = body.email as string;

    if (!fromName || typeof fromName !== "string" || fromName.length > 100) {
      return c.json({ ok: false, error: "fromName required (max 100 chars)" }, 400);
    }
    if (!subject || typeof subject !== "string" || subject.length > 200) {
      return c.json({ ok: false, error: "Subject required (max 200 chars)" }, 400);
    }
    if (!htmlBody || typeof htmlBody !== "string" || htmlBody.length > 50_000) {
      return c.json({ ok: false, error: "Body required (max 50KB)" }, 400);
    }
    if (!email || typeof email !== "string" || !MAILABLE_EMAIL_RE.test(email)) {
      return c.json({ ok: false, error: "A valid test address is required" }, 400);
    }

    const now = Date.now();
    const timestamps = testSendRateMap.get(org) ?? [];
    const recent = timestamps.filter((t) => now - t < BROADCAST_RATE_WINDOW);
    if (recent.length >= TEST_SEND_RATE_LIMIT) {
      return c.json({ ok: false, error: "Rate limit exceeded (5 test sends per hour)" }, 429);
    }

    // Fails closed with the real broadcast (#96). A test send is a REHEARSAL:
    // if it goes out from the transactional address while the real broadcast
    // would be refused, it misrepresents both the outcome and the sender the
    // organiser is previewing. An honest rehearsal fails the way the
    // performance would.
    const marketingFrom = resolveMarketingFrom(org);
    if (!marketingFrom) {
      return c.json(
        { ok: false, error: MARKETING_SENDER_UNCONFIGURED, code: MARKETING_SENDER_UNCONFIGURED_CODE },
        503,
      );
    }

    const result = await sendMarketingBatch({
      organiserAddress: org,
      fromDisplayName: fromName,
      fromAddress: marketingFrom,
      subject: `[Test] ${subject}`,
      html: htmlBody,
      recipients: [{ email }],
    });

    recent.push(now);
    testSendRateMap.set(org, recent);

    return c.json({
      ok: true,
      data: {
        sent: result.sent,
        // A suppressed test address is a real answer, not a failure: it means
        // this inbox unsubscribed from this organiser at some point.
        suppressed: result.suppressed,
        failed: result.failed,
        // Plaintext is right here: it is the one address the organiser just
        // typed into the box, and they are the controller of it.
        ...(result.failures.length > 0
          ? { errors: result.failures.slice(0, 1).map((f) => `${f.email}: ${f.message}`) }
          : {}),
      },
    });
  } catch (err) {
    console.error("[marketing] test send error:", err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Test send failed" }, 500);
  }
});

// ── Organiser sending domain (Resend Domains API) ──────────────────────────

const HOSTNAME_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const LOCAL_PART_RE = /^[a-z0-9._-]{1,64}$/i;

function toInfo(entry: SendingDomainEntry): Record<string, unknown> {
  return {
    domain: entry.domain,
    fromLocalPart: entry.fromLocalPart,
    status: entry.status,
    records: entry.records,
    // Null while unverified AND the platform marketing address is unset — the
    // honest answer, since a marketing send in that state is now refused rather
    // than quietly redirected to the transactional address (#96).
    fromAddress:
      entry.status === "verified"
        ? `${entry.fromLocalPart}@${entry.domain}`
        : getMarketingFromAddress(),
    createdAt: entry.createdAt,
  };
}

marketing.post("/domain", domainsGate, requireAuth, async (c) => {
  const org = c.get("parentAddress").toLowerCase();
  const body = c.get("body") as Record<string, unknown>;

  try {
    const gate = await requireVerifiedSender(org);
    if (gate) return gate;
    if (getDomain(org)) {
      return c.json({ ok: false, error: "A sending domain is already connected — remove it first" }, 409);
    }
    const domain = typeof body.domain === "string" ? body.domain.trim().toLowerCase() : "";
    if (!HOSTNAME_RE.test(domain)) {
      return c.json({ ok: false, error: "Enter a valid domain, e.g. mail.yourvenue.com" }, 400);
    }
    const fromLocalPart =
      typeof body.fromLocalPart === "string" && body.fromLocalPart.trim()
        ? body.fromLocalPart.trim().toLowerCase()
        : "news";
    if (!LOCAL_PART_RE.test(fromLocalPart)) {
      return c.json({ ok: false, error: "From name before the @ can only use letters, numbers, dots, dashes" }, 400);
    }

    const { data, error } = await getResend().domains.create({ name: domain });
    if (error || !data) {
      return c.json({ ok: false, error: error?.message || "Domain registration failed" }, 502);
    }

    const now = new Date().toISOString();
    const entry: SendingDomainEntry = {
      resendDomainId: data.id,
      domain,
      fromLocalPart,
      status: data.status,
      records: (data.records ?? []) as SendingDomainEntry["records"],
      createdAt: now,
      updatedAt: now,
    };
    putDomain(org, entry);
    return c.json({ ok: true, data: toInfo(entry) });
  } catch (err) {
    console.error("[marketing] domain create error:", err);
    const message = err instanceof Error ? err.message : "Domain connect failed";
    return c.json({ ok: false, error: message }, 500);
  }
});

marketing.get("/domain", domainsGate, requireAuth, (c) => {
  const org = c.get("parentAddress").toLowerCase();
  const entry = getDomain(org);
  return c.json({ ok: true, data: entry ? toInfo(entry) : null });
});

marketing.post("/domain/verify", domainsGate, requireAuth, async (c) => {
  const org = c.get("parentAddress").toLowerCase();
  try {
    const entry = getDomain(org);
    if (!entry) return c.json({ ok: false, error: "No sending domain connected" }, 404);

    // Trigger Resend's verification pass, then read back the current state.
    await getResend().domains.verify(entry.resendDomainId);
    const { data, error } = await getResend().domains.get(entry.resendDomainId);
    if (error || !data) {
      return c.json({ ok: false, error: error?.message || "Verification check failed" }, 502);
    }

    const updated: SendingDomainEntry = {
      ...entry,
      status: data.status,
      records: (data.records ?? []) as SendingDomainEntry["records"],
      updatedAt: new Date().toISOString(),
    };
    putDomain(org, updated);
    return c.json({ ok: true, data: toInfo(updated) });
  } catch (err) {
    console.error("[marketing] domain verify error:", err);
    const message = err instanceof Error ? err.message : "Domain verify failed";
    return c.json({ ok: false, error: message }, 500);
  }
});

marketing.delete("/domain", domainsGate, requireAuth, async (c) => {
  const org = c.get("parentAddress").toLowerCase();
  try {
    const entry = getDomain(org);
    if (!entry) return c.json({ ok: false, error: "No sending domain connected" }, 404);

    // Best-effort remote removal — always clear locally so the organiser
    // isn't stuck if the Resend record is already gone.
    try {
      await getResend().domains.remove(entry.resendDomainId);
    } catch (err) {
      console.warn("[marketing] Resend domain remove failed (clearing locally):", err);
    }
    deleteDomain(org);
    return c.json({ ok: true, data: { removed: true } });
  } catch (err) {
    console.error("[marketing] domain delete error:", err);
    const message = err instanceof Error ? err.message : "Domain removal failed";
    return c.json({ ok: false, error: message }, 500);
  }
});

export { marketing };
