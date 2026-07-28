/**
 * Audit — and optionally fix — the payout schedule on every connected account.
 *
 * Accounts created before manual payouts shipped are on Stripe's automatic
 * schedule: their organiser is paid out days after the sale, long before the
 * event, and if that event is later cancelled the money is already gone. The
 * account.updated webhook self-heals any account that emits an update, but a
 * dormant already-onboarded account may never emit one — so this exists.
 *
 * Read-only by default. Run with --fix to correct what it finds.
 *
 *   dev:  cd apps/server && npx tsx scripts/payout-schedule-audit.ts [--fix]
 *   prod: docker compose exec -w /app server npx tsx apps/server/scripts/payout-schedule-audit.ts [--fix]
 *
 * The store is resolved from process.cwd()/.data, so this MUST run from the same
 * working directory as the server or it audits an empty store and reports "0
 * accounts" — which looks like a pass. In the container that is /app, not
 * /app/apps/server.
 */

import "dotenv/config";
import { getStripe } from "../src/lib/stripe/client.js";
import { ensureManualPayoutSchedule } from "../src/lib/stripe/payout-schedule.js";
import { listStripeAccounts } from "../src/lib/stripe/accounts.js";

const FIX = process.argv.includes("--fix");

function loadAccounts(): Array<{ organiser: string; stripeAccountId: string }> {
  return listStripeAccounts().map(({ organiserAddress, record }) => ({
    organiser: organiserAddress,
    stripeAccountId: record.stripeAccountId,
  }));
}

async function main(): Promise<void> {
  const accounts = loadAccounts();
  if (accounts.length === 0) {
    // An empty store and a wrong cwd are indistinguishable in the output otherwise.
    console.error(`No accounts found in ${process.cwd()}/.data/stripe-accounts.json`);
    console.error("If that path looks wrong, re-run from the server's working directory.");
    process.exit(1);
  }
  console.log(`Auditing ${accounts.length} connected account(s)${FIX ? " (WILL FIX)" : " (read-only)"}\n`);

  const s = getStripe();
  let manual = 0;
  let wrong = 0;
  let fixed = 0;
  let errored = 0;

  for (const { organiser, stripeAccountId } of accounts) {
    try {
      const account = await s.accounts.retrieve(stripeAccountId);
      const interval = account.settings?.payouts?.schedule?.interval;
      const label = `${stripeAccountId}  ${organiser.slice(0, 10)}…  country=${account.country ?? "?"}`;

      if (interval === "manual") {
        manual++;
        console.log(`  ok       ${label}  interval=manual`);
        continue;
      }

      wrong++;
      console.log(`  ⚠️ WRONG  ${label}  interval=${interval ?? "unset"}`);
      if (FIX) {
        const ok = await ensureManualPayoutSchedule(stripeAccountId);
        if (ok) {
          fixed++;
          console.log(`           → set to manual`);
        }
      }
    } catch (err) {
      errored++;
      console.log(`  ERROR    ${stripeAccountId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(
    `\nmanual=${manual} wrong=${wrong}${FIX ? ` fixed=${fixed}` : ""} errors=${errored}`,
  );
  if (wrong > 0 && !FIX) console.log("Re-run with --fix to correct these.");
  // Non-zero exit when something is wrong and we didn't fix it — usable in a check.
  if (wrong > fixed) process.exitCode = 1;
}

void main();
