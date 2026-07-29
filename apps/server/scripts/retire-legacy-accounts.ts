/**
 * Retire pre-#90 platform-liable connected accounts.
 *
 * Accounts created with `type: "express"` carry `controller.losses.payments =
 * "application"` forever — they cannot be converted to Managed Risk, only
 * replaced. Stripe allows a platform to delete a live account it is liable for
 * once every balance is zero; the organiser simply re-runs /connect and
 * onboards a fresh Managed Risk account.
 *
 * Read-only by default: reports each account's liability, balance, and held
 * ledger entries. Run with --delete to remove zero-balance platform-liable
 * accounts from Stripe AND the local store. Never touches an account that is
 * Managed Risk (losses=stripe), has a non-zero balance, or has held ledger
 * entries.
 *
 *   dev:  cd apps/server && npx tsx scripts/retire-legacy-accounts.ts [--delete]
 *   prod: docker compose exec -w /app server npx tsx apps/server/scripts/retire-legacy-accounts.ts [--delete]
 *
 * Same cwd caveat as payout-schedule-audit.ts: the store is process.cwd()/.data.
 */

import "dotenv/config";
import { getStripe } from "../src/lib/stripe/client.js";
import { listStripeAccounts, deleteStripeAccount } from "../src/lib/stripe/accounts.js";
import { listByOrganiser } from "../src/lib/stripe/payout-ledger.js";
import { isPlatformLiable } from "../src/lib/stripe/account-params.js";

const DELETE = process.argv.includes("--delete");

async function main(): Promise<void> {
  const accounts = listStripeAccounts();
  if (accounts.length === 0) {
    console.error(`No accounts found in ${process.cwd()}/.data/stripe-accounts.json`);
    console.error("If that path looks wrong, re-run from the server's working directory.");
    process.exit(1);
  }
  console.log(
    `Checking ${accounts.length} connected account(s)${DELETE ? " (WILL DELETE legacy)" : " (read-only)"}\n`,
  );

  const s = getStripe();
  let managedRisk = 0;
  let legacy = 0;
  let deleted = 0;
  let blocked = 0;
  let errored = 0;

  for (const { organiserAddress, record } of accounts) {
    const id = record.stripeAccountId;
    try {
      const account = await s.accounts.retrieve(id);
      if (!isPlatformLiable(account)) {
        managedRisk++;
        console.log(`  ok      ${id}  ${organiserAddress.slice(0, 10)}…  losses=stripe`);
        continue;
      }

      legacy++;
      const balance = await s.balance.retrieve({}, { stripeAccount: id });
      const nonZero = [...balance.available, ...balance.pending].filter((b) => b.amount !== 0);
      const held = listByOrganiser(organiserAddress).filter((e) => e.status === "held");
      const balanceLabel =
        nonZero.length === 0
          ? "balance=0"
          : `balance=${nonZero.map((b) => `${b.amount} ${b.currency}`).join(", ")}`;
      console.log(
        `  LEGACY  ${id}  ${organiserAddress.slice(0, 10)}…  losses=` +
          `${account.controller?.losses?.payments ?? "application (type: express)"}  ${balanceLabel}  held=${held.length}`,
      );

      if (nonZero.length > 0 || held.length > 0) {
        blocked++;
        console.log(`          → NOT deletable: funds or held ledger entries present`);
        continue;
      }
      if (DELETE) {
        await s.accounts.del(id);
        deleteStripeAccount(organiserAddress);
        deleted++;
        console.log(`          → deleted from Stripe + store (organiser can re-onboard via /connect)`);
      }
    } catch (err) {
      errored++;
      console.log(`  ERROR   ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(
    `\nmanagedRisk=${managedRisk} legacy=${legacy}${DELETE ? ` deleted=${deleted}` : ""} blocked=${blocked} errors=${errored}`,
  );
  if (legacy > deleted && !DELETE) console.log("Re-run with --delete to retire the deletable ones.");
  if (legacy > deleted) process.exitCode = 1;
}

void main();
