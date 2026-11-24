/**
 * The automatic collection of signed-in receipts (`collect.ts`), bound to the signed-in
 * account. Registered by the main app (`main.ts`), never imported by the auth store: the
 * deployed-site builds share the store, and their files are baked into every site.
 *
 * The store asks for a run when the account's keys become usable here - a passkey
 * account's confirmed unlock, an email or Google account's sign-in - and when a session
 * first appears. A run happens only when ALL of these hold, and asks for nothing:
 *  - receipts are switched on, and the account is a passkey or email/Google one;
 *  - a session is already on this device (`/mine` is signed; none is ever started);
 *  - the CURRENT key generation is confirmed without a prompt (`silent`), and this
 *    device holds the keys - a locked passkey account waits for its next unlock;
 *  - no upgrade to a passkey is half done here (`receiptSavesPaused`);
 *  - no run for this account is going on in another tab, and none finished in this tab
 *    in the last `COLLECT_EVERY_MS` (unless `force`).
 *
 * What our server sees (said plainly): one signed request for the account's own sales -
 * already linked to it by the purchase - then, per receipt, its box read from our
 * gateway by root (or the pickup API while unstored), the account's save through the
 * storage relay, and the unsigned erase. Nothing it did not already know.
 */
import { FEATURES } from "@woco/shared";
import { auth } from "../auth/auth-store.svelte.js";
import { ifLockFree } from "../utils/web-lock.js";
import type { CollectReport } from "./collect.js";
import { bumpReceiptsChanged } from "./receipts-changed.svelte.js";
import { receiptSavesPaused } from "./upgrade-pause.js";

export const COLLECT_EVERY_MS = 5 * 60_000;
/** A run that has not finished by then lets the next one start (each call has its own timeout too). */
export const COLLECT_RUN_MAX_MS = 10 * 60_000;
const STAMP_PREFIX = "woco:holding:collected:";

/** Per tab (sessionStorage): a reload does not ask the server again within the interval. */
function ranRecently(parent: string, now: number): boolean {
  try {
    const at = Number(globalThis.sessionStorage?.getItem(STAMP_PREFIX + parent));
    return Number.isFinite(at) && at > 0 && at <= now && now - at < COLLECT_EVERY_MS;
  } catch {
    return false;
  }
}

function stamp(parent: string, now: number): void {
  try {
    globalThis.sessionStorage?.setItem(STAMP_PREFIX + parent, String(now));
  } catch {
    /* storage blocked: the next trigger runs again */
  }
}

function bounded<T>(p: Promise<T>): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), COLLECT_RUN_MAX_MS);
    p.then(
      (v) => resolve(v),
      (e) => {
        console.warn("[receipts] collection stopped (tried again later):", e);
        resolve(null);
      },
    ).finally(() => clearTimeout(timer));
  });
}

/** One run for the signed-in account, if everything above holds. Null when none ran. */
export async function collectInBackground(opts: { force?: boolean } = {}): Promise<CollectReport | null> {
  if (!FEATURES.holdingReceiptsAllowed) return null;
  const parent = auth.parent?.toLowerCase();
  const kind = auth.kind;
  if (!parent || (kind !== "passkey" && kind !== "web3auth") || !auth.hasSession) return null;
  if (!opts.force && ranRecently(parent, Date.now())) return null;
  if (receiptSavesPaused(parent, kind)) return null;

  // The account's keys when the run starts: a sign-out, another sign-in or a relock moves one.
  const seedAddress = auth.seedAddress;
  const bound = () =>
    auth.parent?.toLowerCase() === parent && auth.seedAddress === seedAddress && auth.hasSession && !receiptSavesPaused(parent, auth.kind);

  const ran = await ifLockFree(`woco:holding:collect:${parent}`, () =>
    bounded(
      (async (): Promise<CollectReport | null> => {
        // Saving needs the CURRENT generation, confirmed - silently: an unconfirmed one throws, and nothing runs.
        const sealing = await auth.getAccountSecrets({ toSeal: true, silent: true }).catch(() => null);
        const held = sealing ? await auth.getAccountSecrets().catch(() => null) : null;
        if (!sealing || !held || !bound()) return null;

        const [{ holdingGenKeysOf }, { collectReceipts }, { liveHoldingFeedIO }, { fetchHoldingBox }, { liveKeepDeps }, { mineHoldings }] =
          await Promise.all([
            import("./account-copy.js"),
            import("./collect.js"),
            import("./holding-io.js"),
            import("./box-source.js"),
            import("./keep.js"),
            import("../api/holdings.js"),
          ]);
        const gens = await Promise.all(held.all.map((s) => holdingGenKeysOf(s)));
        const at = held.all.lastIndexOf(sealing.current);
        const current = at >= 0 ? gens[at]! : await holdingGenKeysOf(sealing.current);
        let ringRead: Promise<boolean> | null = null;
        try {
          stamp(parent, Date.now());
          const report = await collectReceipts({
            mine: () => mineHoldings(),
            gens,
            current,
            fetchBox: (r, root) => fetchHoldingBox(r, root),
            io: liveHoldingFeedIO,
            keep: await liveKeepDeps(),
            // Right before every save or erase: the same account and current secret, no upgrade
            // begun meanwhile, and one fresh read of the key ring's anchor per run (no prompt) -
            // never the verdict alone.
            async stillCurrent() {
              if (!bound()) return false;
              const again = await auth.getAccountSecrets({ toSeal: true, silent: true }).catch(() => null);
              if (!again || !bound() || again.current !== sealing.current) return false;
              ringRead ??= auth.keyRingStillCurrent().catch(() => false);
              return (await ringRead) && bound();
            },
          });
          if (report.saved > 0 || report.erased > 0) bumpReceiptsChanged();
          return report;
        } finally {
          for (const g of gens) g.orderSecretKey.fill(0);
          current.orderSecretKey.fill(0);
        }
      })(),
    ),
  );
  return ran.ran ? ran.value : null;
}
