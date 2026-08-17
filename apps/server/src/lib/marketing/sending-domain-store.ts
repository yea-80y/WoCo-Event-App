/**
 * Organiser sending domains — send marketing from the organiser's own domain
 * (their brand, their reputation) via Resend's Domains API. Verification
 * state comes from Resend (they are the DNS authority here — unlike the site
 * custom-domain poller which checks DNS itself); we cache id/status/records
 * so the panel renders without an API call. MUST survive restarts.
 *
 * Compliance invariant: the from-domain changes NOTHING about suppression or
 * List-Unsubscribe — every send still goes through sendMarketingBatch.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SendingDomainRecord } from "@woco/shared";
import { getMarketingFromAddress } from "../email/client.js";
import { writeJsonAtomic } from "./persist.js";

/**
 * Shown to the organiser when `resolveMarketingFrom` returns null. It names the
 * platform as the cause on purpose — they have done nothing wrong and there is
 * no action they can take.
 *
 * Written to stand on its own even though the WoCo composer pairs it with a
 * title and a draft-is-safe line: any other client, and this one before it
 * learned to branch on the code below, shows this string and nothing else.
 */
export const MARKETING_SENDER_UNCONFIGURED =
  "WoCo has not finished setting up its marketing sending address, so nothing was " +
  "sent. This is on our side, not a problem with your account.";

/**
 * Response `code` for the refusal — the documented branch point for UI
 * ("branches on this, never on the human-readable `error` text"). Defined once
 * here so the two routes that emit it cannot drift apart by a typo, which would
 * degrade silently to the generic error path.
 */
export const MARKETING_SENDER_UNCONFIGURED_CODE = "MARKETING_SENDER_NOT_CONFIGURED";

const DATA_DIR = join(process.cwd(), ".data");
const STORE_FILE = join(DATA_DIR, "marketing-domains.json");

export interface SendingDomainEntry {
  resendDomainId: string;
  domain: string;
  fromLocalPart: string;
  status: string;
  records: SendingDomainRecord[];
  createdAt: string;
  updatedAt: string;
}

const domains = new Map<string, SendingDomainEntry>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const obj = JSON.parse(raw) as Record<string, SendingDomainEntry>;
    for (const [org, entry] of Object.entries(obj)) domains.set(org, entry);
  } catch {
    // File doesn't exist yet — that's fine
  }
}

function persistToDisk(): void {
  writeJsonAtomic(STORE_FILE, Object.fromEntries(domains), "marketing-domains");
}

export function getDomain(organiserAddress: string): SendingDomainEntry | null {
  ensureLoaded();
  return domains.get(organiserAddress.toLowerCase()) ?? null;
}

export function putDomain(organiserAddress: string, entry: SendingDomainEntry): void {
  ensureLoaded();
  domains.set(organiserAddress.toLowerCase(), entry);
  persistToDisk();
}

export function deleteDomain(organiserAddress: string): void {
  ensureLoaded();
  domains.delete(organiserAddress.toLowerCase());
  persistToDisk();
}

/**
 * From-address resolution: verified organiser domain → platform marketing
 * address → `null`.
 *
 * `null` means "this send has no marketing address to go out from", and the
 * only correct response to it on the marketing lane is to refuse. It never
 * degrades to the transactional address — see `getMarketingFromAddress`.
 */
export function resolveMarketingFrom(organiserAddress: string): string | null {
  const d = getDomain(organiserAddress);
  if (d && d.status === "verified") return `${d.fromLocalPart}@${d.domain}`;
  return getMarketingFromAddress();
}
