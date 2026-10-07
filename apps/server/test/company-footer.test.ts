/**
 * Every business email names the company behind it: registered name, number,
 * where registered and registered office (UK trading disclosure). One line,
 * one constant - `@woco/shared` legal/company.ts.
 *
 * MUTATION: drop `companyFooterHtml(...)` from any builder, or the company
 * line from the marketing footer, and its case goes red; add a new
 * `sendEmail(` caller whose own file and imported builders all lack the footer
 * and the source scan goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WOCO_COMPANY, WOCO_COMPANY_LINE } from "@woco/shared";

process.env.EMAIL_HASH_SECRET ??= "test-secret-for-company-footer";

const { buildTicketHtml } = await import("../src/routes/tickets.ts");
const { buildContactHtml } = await import("../src/routes/sites.ts");
const { buildRequirementNudge } = await import("../src/lib/email/requirement-nudge.ts");
const { buildReceiptHtml } = await import("../src/lib/email/shop-receipt.ts");
const { footerHtml, footerText } = await import("../src/lib/email/marketing-footer.ts");
const { companyFooterText } = await import("../src/lib/email/company-footer.ts");

test("the company line names the company, its number, where registered and its office", () => {
  assert.equal(
    WOCO_COMPANY_LINE,
    "WoCo Network Ltd · Registered in England and Wales, company number 17370809 · 128 City Road, London EC1V 2NX, United Kingdom",
  );
  for (const part of Object.values(WOCO_COMPANY)) assert.ok(WOCO_COMPANY_LINE.includes(part), part);
});

test("ticket email", () => {
  const html = buildTicketHtml({ to: "a@example.com", eventTitle: "Night", tickets: [{ edition: 1, qrContent: "x" }] });
  assert.ok(html.includes(WOCO_COMPANY_LINE));
});

test("site contact-form email", () => {
  assert.ok(buildContactHtml("Ann", "ann@example.com", "Hello", "Venue").includes(WOCO_COMPANY_LINE));
});

test("payout requirement nudge, both parts", () => {
  const n = buildRequirementNudge({
    to: "o@example.com",
    due: ["external_account"],
    disabledReason: null,
    payoutsUrl: "https://woco.eth.limo/#/creator/payouts",
  });
  assert.ok(n.html.includes(WOCO_COMPANY_LINE));
  assert.ok(n.text.includes(WOCO_COMPANY_LINE));
});

test("shop receipt", () => {
  const html = buildReceiptHtml(
    "Bar",
    { code: "K4P-92", currency: "GBP", total: "5.00", lines: [{ name: "Tea", qty: 1, unitPrice: "5.00" }] } as never,
    "b@example.com",
  );
  assert.ok(html.includes(WOCO_COMPANY_LINE));
});

test("marketing and service-notice footer, both parts, beside the postal address", () => {
  const ctx = { displayName: "Org", unsubUrl: "https://x/u", postalAddress: "WoCo Network Ltd, 128 City Road" };
  for (const out of [footerHtml(ctx), footerText(ctx)]) {
    assert.ok(out.includes(WOCO_COMPANY_LINE));
    assert.ok(out.includes(ctx.postalAddress));
  }
  assert.ok(companyFooterText().includes(WOCO_COMPANY_LINE));
});

test("every caller of sendEmail adds the company footer", () => {
  const src = fileURLToPath(new URL("../src", import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk(src);
  const callers = files.filter((p) => /\bsendEmail\(\s*[{\n]/.test(readFileSync(p, "utf8")));
  assert.ok(callers.length >= 4, "the scan must find the known senders");
  // The footer may sit in the sender itself or in a builder module it imports.
  const addsFooter = (p: string) => /companyFooterHtml\(/.test(readFileSync(p, "utf8"));
  const importedModules = (p: string) =>
    [...readFileSync(p, "utf8").matchAll(/from "(\.{1,2}\/[^"]+)\.js"/g)].map((m) => join(dirname(p), `${m[1]}.ts`));
  for (const p of callers) {
    assert.ok(
      addsFooter(p) || importedModules(p).some((m) => existsSync(m) && addsFooter(m)),
      `${p.slice(src.length)} sends email without the company footer`,
    );
  }
});
