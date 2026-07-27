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
 *   npx tsx scripts/payout-schedule-audit.ts
 *   npx tsx scripts/payout-schedule-audit.ts --fix
 *
 * Run from apps/server (it reads .data/stripe-accounts.json via process.cwd()).
 */

import "dotenv/config";
import { getStripe } from "../src/lib/stripe/client.js";
import { ensureManualPayoutSchedule } from "../src/lib/stripe/payout-schedule.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIX = process.argv.includes("--fix");

interface AccountRecord {
  stripeAccountId: string;
  onboardingComplete: boolean;
}

function loadAccounts(): Array<{ organiser: string; stripeAccountId: string }> {
  const file = join(process.cwd(), ".data", "stripe-accounts.json");
  const store = JSON.parse(readFileSync(file, "utf-8")) as Record<string, AccountRecord>;
  return Object.entries(store).map(([organiser, r]) => ({
    organiser,
    stripeAccountId: r.stripeAccountId,
  }));
}

async function main(): Promise<void> {
  const accounts = loadAccounts();
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
