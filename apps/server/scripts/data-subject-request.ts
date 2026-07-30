/**
 * Data-subject request tool — UK GDPR Art. 15 (access) and Art. 17 (erasure).
 *
 * Thin CLI over `lib/marketing/subject-request.ts`, which holds the policy (and
 * the tests). Before this existed, servicing a request meant hand-editing
 * .data/*.json on the VM, which is not a process you want to be inventing inside
 * a 30-day statutory clock (#83).
 *
 * A script rather than an HTTP route on purpose: there is no admin identity in
 * this system, and inventing one — an admin bearer token guarding bulk erasure —
 * would be a worse attack surface than the problem it solves. SSH to the VM is
 * already the admin boundary.
 *
 *   npx tsx scripts/data-subject-request.ts --email a@b.com
 *   npx tsx scripts/data-subject-request.ts --email a@b.com --erase
 *   npx tsx scripts/data-subject-request.ts --email a@b.com --erase --organiser 0x…
 *
 * MUST run with cwd = the server working directory (the one holding .data), and
 * with the same EMAIL_HASH_SECRET the data was written under — the stores are
 * keyed by HMAC hash, so a different secret finds nothing and reports "no data"
 * for a person who very much has some.
 */

import { hashEmail } from "../src/lib/event/claim-service.js";
import { eraseSubject, reportSubject } from "../src/lib/marketing/subject-request.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const email = arg("email");
const organiser = arg("organiser")?.toLowerCase();
const erase = process.argv.includes("--erase");

if (!email) {
  console.error("usage: data-subject-request.ts --email <address> [--erase] [--organiser <0x…>]");
  process.exit(1);
}
if (!process.env.EMAIL_HASH_SECRET) {
  console.error("EMAIL_HASH_SECRET is not set — every lookup would miss. Refusing to run.");
  process.exit(1);
}

const h = hashEmail(email);
console.log(`\nSubject: ${email}\nHash:    ${h}\nScope:   ${organiser ?? "all organisers"}\n`);

const report = reportSubject(h, organiser);

console.log("CONSENT RECORDS (lawful-basis evidence, Art. 7(1))");
if (report.consents.length === 0) console.log("  none");
for (const { org, record } of report.consents) {
  console.log(`  ${org}  ${record.ts}  source=${record.source}  event=${record.eventId ?? "—"}  v${record.version ?? "?"}`);
  console.log(`    notice: "${record.notice}"`);
}

console.log("\nMARKETING LIST MEMBERSHIP (server index of the organiser's sealed list)");
console.log(report.lists.length ? report.lists.map((o) => `  ${o}`).join("\n") : "  none");

console.log("\nSUPPRESSION MARKS (record of an objection — Art. 17(3)(b), NOT erasable)");
const marks = report.marks;
if (!marks) {
  console.log("  none");
} else {
  if (marks.global) {
    console.log(`  GLOBAL  ${marks.global.ts}  source=${marks.global.source}${marks.global.liftedAt ? `  LIFTED ${marks.global.liftedAt}` : ""}`);
  }
  for (const [org, m] of Object.entries(marks.orgs)) {
    if (organiser && org !== organiser) continue;
    console.log(`  ${org}  ${m.ts}  source=${m.source}${m.liftedAt ? `  LIFTED ${m.liftedAt} by ${m.liftedBy}` : ""}`);
  }
}

console.log(`\nUNDELIVERED EMAIL RECORDS (${report.emailFailures.length})`);
for (const f of report.emailFailures) {
  console.log(
    `  ${f.ts}  ${f.kind}  ${f.recipient ? "PLAINTEXT HELD" : "hash only"}` +
      `${f.resolvedAt ? `  resolved ${f.resolvedAt} by ${f.resolvedBy}` : "  UNRESOLVED"}  ${f.error}`,
  );
}
if (organiser) {
  console.log("  (not searched — organiser-scoped request; the ledger is platform-level)");
}

if (!erase) {
  console.log("\n(read-only — pass --erase to action an Art. 17 request)\n");
  process.exit(0);
}

console.log("\n── ERASING ──");
const result = eraseSubject(h, organiser);
console.log(`  suppression: ${result.suppression === "global" ? "GLOBAL mark recorded" : `organiser-scoped mark recorded for ${organiser}`}`);
console.log(`  consent records erased: ${result.consentsErased}`);
console.log(`  removed from list index of: ${result.listsRemovedFrom.length ? result.listsRemovedFrom.join(", ") : "no organiser"}`);
console.log(
  `  undelivered-email records redacted: ${result.emailFailuresRedacted}` +
    (organiser ? "  (skipped — organiser-scoped request; the ledger is platform-level)" : ""),
);

if (!result.persisted) {
  console.error(`
  !!! AT LEAST ONE STORE FAILED TO WRITE TO DISK. The erasure exists only in this
  process's memory and will be LOST on the next restart. Do NOT tell the subject
  it was actioned. Check disk space and permissions on .data/, then re-run.
`);
  process.exit(2);
}

console.log(`
── STILL OUTSIDE THIS SCRIPT'S REACH — tell the subject, and the organiser ──

  1. The organiser's SEALED contact blob on Swarm still contains this address.
     It is encrypted to a key only they hold, so only they can rewrite it. They
     are the controller for their list: forward the request to them. Until they
     do, the suppression mark above is what actually stops sends.
  2. Ticket records on Swarm cannot be individually deleted — the disclosed
     remedy (CHECKOUT_PRIVACY_SUMMARY) is destroying the key that makes the
     sealed order readable and letting the storage stamp lapse.
  3. Stripe holds its own payment records under its own retention obligations.

  Log the request, the date, and what was done. Art. 12(3): respond within one
  month.
`);
