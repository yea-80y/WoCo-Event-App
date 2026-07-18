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

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SendingDomainRecord } from "@woco/shared";
import { getMarketingFromAddress } from "../email/client.js";

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
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STORE_FILE, JSON.stringify(Object.fromEntries(domains)), "utf-8");
  } catch (err) {
    console.error("[marketing-domains] Failed to persist to disk:", err);
  }
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

/** From-address resolution: verified organiser domain → platform marketing address. */
export function resolveMarketingFrom(organiserAddress: string): string {
  const d = getDomain(organiserAddress);
  if (d && d.status === "verified") return `${d.fromLocalPart}@${d.domain}`;
  return getMarketingFromAddress();
}
