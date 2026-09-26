/**
 * The scanner's half of #641: ask the server to admit a ticket, and reduce every
 * way that can go to one of four answers.
 *
 * Only one of them lets anyone in: a 200 whose body says "admitted" for THIS
 * ticket. A timeout, a network error, a 5xx, a malformed body or an answer about
 * a different ticket are all "couldn't confirm" - the door must not treat silence
 * as a yes, because the next scanner along may be admitting the same ticket.
 *
 * Plain TypeScript with the fetch passed in, so it is testable without a browser
 * (`apps/web/test/scanner-claim.test.ts`).
 */
import {
  SCANNER_DEVICE_HEADER,
  type CheckinClaimRequest,
  type CheckinClaimResponse,
  type CheckinRecord,
} from "@woco/shared";

/** Long enough for a slow 4G round trip, short enough that a queue notices. */
export const CLAIM_TIMEOUT_MS = 4000;

export type ClaimAnswer =
  | { kind: "admitted"; record: CheckinRecord }
  | { kind: "already-in"; record: CheckinRecord }
  /** The pass was revoked or expired - no scan on this device can succeed. */
  | { kind: "pass-dead"; message: string }
  | { kind: "cant-confirm"; message: string };

export interface ClaimCall {
  fetchFn: typeof fetch;
  apiBase: string;
  eventId: string;
  token: string;
  deviceId: string;
  claim: CheckinClaimRequest;
  timeoutMs?: number;
}

export async function claimAdmission(call: ClaimCall): Promise<ClaimAnswer> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), call.timeoutMs ?? CLAIM_TIMEOUT_MS);
  try {
    const resp = await call.fetchFn(`${call.apiBase}/api/checkin/${encodeURIComponent(call.eventId)}/claim`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Door-Pass": call.token,
        [SCANNER_DEVICE_HEADER]: call.deviceId,
      },
      body: JSON.stringify(call.claim),
      signal: ctl.signal,
    });
    const body = (await resp.json().catch(() => null)) as
      | { ok?: boolean; data?: CheckinClaimResponse; error?: string }
      | null;

    if (resp.status === 401 || resp.status === 403) {
      return { kind: "pass-dead", message: body?.error ?? "Door pass no longer valid" };
    }
    if (resp.status === 409) {
      return { kind: "cant-confirm", message: body?.error ?? "This door pass belongs to another scanner" };
    }
    if (!resp.ok || !body?.ok || !body.data) {
      return { kind: "cant-confirm", message: "WoCo couldn't record this check-in - scan again" };
    }

    const { status, record } = body.data;
    const sameTicket = record?.seriesId === call.claim.seriesId && record?.edition === call.claim.edition;
    if (status === "admitted" && sameTicket) return { kind: "admitted", record };
    if (status === "already-in" && sameTicket) return { kind: "already-in", record };
    return { kind: "cant-confirm", message: "Unexpected answer from WoCo - scan again" };
  } catch {
    // Aborted by the timeout, or no network at all.
    return { kind: "cant-confirm", message: "No answer from WoCo - scan again" };
  } finally {
    clearTimeout(timer);
  }
}

/** Random per scan attempt. A retry of the same attempt reuses it. */
export function newClaimId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}
