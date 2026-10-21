/**
 * `/api/health` `signInWindow`: can the app still open the passkey sign-in window
 * and hear it answer?
 *
 * Every passkey ceremony runs in a top-level window on `auth.woco.eth.limo`, opened
 * from the app at `woco.eth.limo`, and the window hands its result back over
 * `window.opener.postMessage`. Both responses are eth.limo's, not ours, and two of
 * its headers decide whether that still works:
 *
 *  - Cross-Origin-Opener-Policy. Anything but `unsafe-none` on EITHER response puts
 *    the two pages in different browsing-context groups: the window loses its
 *    opener, the app's handle reads `closed`, and every passkey sign-in fails. Not
 *    sent by either host when this was written (measured 2026-10-09 and 10-21).
 *  - X-Frame-Options. Both send `SAMEORIGIN` today, which is why a window and not a
 *    frame is the transport at all. A change is not itself a break - the window
 *    refuses to run framed - but it means eth.limo changed what it sends, and the
 *    next change could be the one above.
 *
 * Red on a COOP that severs the opener, an X-Frame-Options other than SAMEORIGIN,
 * or a non-2xx answer (no window means no passkey sign-in). Unknown when a host
 * cannot be reached. What it does NOT check is the window's BYTES: that it is
 * still the page the Safe pinned on L1 is a separate probe, not built yet.
 */
import { PASSKEY_WINDOW_ORIGIN, WOCO_APP_ORIGIN } from "@woco/shared";
import { errorClass } from "../http/error-class.js";
import { type Check, type Verdict, combine, isStale } from "./alarms.js";

export const SIGN_IN_WINDOW_PROBE_INTERVAL_MS = 10 * 60_000;
const TIMEOUT_MS = 15_000;

/** The two origins whose headers decide the sign-in window, opener first. */
export const SIGN_IN_WINDOW_ORIGINS = [WOCO_APP_ORIGIN, PASSKEY_WINDOW_ORIGIN] as const;

export type HeaderRead =
  | { ok: true; status: number; coop: string | null; xfo: string | null }
  | { ok: false; reason: string };

export type FetchHeaders = (origin: string) => Promise<HeaderRead>;

export interface OriginReading {
  origin: string;
  read: HeaderRead;
}

export interface SignInWindowReading {
  at: number;
  origins: OriginReading[];
}

/** One origin's verdict. Pure. */
export function evaluateOrigin(read: HeaderRead): Check {
  if (!read.ok) return { ok: null, reason: `could not be read: ${read.reason}` };
  if (read.status < 200 || read.status > 299) return { ok: false, reason: `answered HTTP ${read.status}` };
  const coop = read.coop?.split(";")[0]!.trim().toLowerCase() ?? "";
  if (coop !== "" && coop !== "unsafe-none") {
    return { ok: false, reason: `sends Cross-Origin-Opener-Policy: ${read.coop} - the sign-in window loses its opener` };
  }
  // A repeated header arrives comma-joined; every copy must still say SAMEORIGIN.
  if (!read.xfo || read.xfo.split(",").some((v) => v.trim().toUpperCase() !== "SAMEORIGIN")) {
    return { ok: false, reason: `X-Frame-Options changed from SAMEORIGIN to ${read.xfo ?? "absent"}` };
  }
  return { ok: true };
}

/** The section's verdict over a reading. Pure. */
export function evaluateSignInWindow(r: SignInWindowReading | null): Check {
  if (!r) return { ok: null, reason: "not checked yet" };
  const checks = r.origins.map((o) => ({ origin: o.origin, ...evaluateOrigin(o.read) }));
  const ok = combine(checks);
  if (ok === true) return { ok };
  const named = checks.filter((c) => c.ok === ok).map((c) => `${new URL(c.origin).host} ${c.reason}`);
  return { ok, reason: named.join("; ") };
}

/** A GET of the origin's root, headers only: the body is not read. */
export const fetchOriginHeaders: FetchHeaders = async (origin) => {
  try {
    const r = await fetch(`${origin}/`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    await r.body?.cancel().catch(() => {});
    return {
      ok: true,
      status: r.status,
      coop: r.headers.get("cross-origin-opener-policy"),
      xfo: r.headers.get("x-frame-options"),
    };
  } catch (err) {
    return { ok: false, reason: errorClass(err) };
  }
};

export async function probeSignInWindow(fetchHeaders: FetchHeaders, now: () => number = Date.now): Promise<SignInWindowReading> {
  const origins = await Promise.all(
    SIGN_IN_WINDOW_ORIGINS.map(async (origin) => ({
      origin,
      read: await fetchHeaders(origin).catch((err): HeaderRead => ({ ok: false, reason: errorClass(err) })),
    })),
  );
  return { at: now(), origins };
}

let reading: SignInWindowReading | null = null;
let lastVerdict: Verdict | undefined;
let timer: NodeJS.Timeout | null = null;

export interface SignInWindowSection {
  ok: Verdict;
  reason?: string;
  stale: boolean;
  checkedAt: string | null;
  origins: Array<{
    origin: string;
    ok: Verdict;
    reason?: string;
    status: number | null;
    crossOriginOpenerPolicy: string | null;
    xFrameOptions: string | null;
  }>;
}

export function signInWindowHealth(now: number = Date.now()): SignInWindowSection {
  const verdict = evaluateSignInWindow(reading);
  return {
    ok: verdict.ok,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    stale: isStale(reading?.at ?? null, now, SIGN_IN_WINDOW_PROBE_INTERVAL_MS),
    checkedAt: reading ? new Date(reading.at).toISOString() : null,
    origins: (reading?.origins ?? []).map(({ origin, read }) => {
      const check = evaluateOrigin(read);
      return {
        origin,
        ok: check.ok,
        ...(check.reason ? { reason: check.reason } : {}),
        status: read.ok ? read.status : null,
        crossOriginOpenerPolicy: read.ok ? read.coop : null,
        xFrameOptions: read.ok ? read.xfo : null,
      };
    }),
  };
}

export async function refreshSignInWindowHealth(
  fetchHeaders: FetchHeaders = fetchOriginHeaders,
  log: (line: string) => void = console.warn,
): Promise<void> {
  reading = await probeSignInWindow(fetchHeaders);
  const verdict = evaluateSignInWindow(reading);
  // One line per crossing, like the other probes: a line every tick is read by nobody.
  if (verdict.ok !== lastVerdict) {
    lastVerdict = verdict.ok;
    log(`[health] signInWindow: ${verdict.ok === true ? "ok" : verdict.ok === false ? "ALARM" : "unknown"}${verdict.reason ? ` - ${verdict.reason}` : ""}`);
  }
}

export function startSignInWindowProbe(): void {
  if (timer) return;
  const tick = () => void refreshSignInWindowHealth().catch((err) => console.warn("[health] sign-in window probe threw:", err));
  tick();
  timer = setInterval(tick, SIGN_IN_WINDOW_PROBE_INTERVAL_MS);
  timer.unref?.();
}

/** Tests only. */
export function __resetSignInWindowHealth(): void {
  if (timer) clearInterval(timer);
  timer = null;
  reading = null;
  lastVerdict = undefined;
}
