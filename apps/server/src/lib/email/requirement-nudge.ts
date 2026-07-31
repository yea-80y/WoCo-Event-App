/**
 * "Stripe needs something from you" — the email that keeps money moving.
 *
 * Deliberately short and specific. The organiser does not need to be taught
 * what Stripe requirements are; they need to know that their payouts are at
 * risk and where to go. The requirement keys Stripe gives us are machine
 * names (`company.tax_id`, `representative.dob.day`), so they are translated
 * where we can and otherwise left out entirely rather than shown raw.
 */

import { getFromAddress } from "./client.js";
import { sendEmail } from "./send.js";

/**
 * Plain-English names for the requirements organisers actually hit.
 *
 * Anything unmapped is omitted rather than guessed at: "we need
 * company.ownership_declaration" reads as a bug, and the panel shows the real
 * list anyway. The count is always honest even when the names are not shown.
 */
const FRIENDLY: Record<string, string> = {
  "business_profile.url": "your business website",
  "business_profile.mcc": "what your business sells",
  "business_profile.product_description": "a description of what you sell",
  "business_profile.support_phone": "a support phone number",
  "business_type": "your business type",
  "company.tax_id": "your company tax ID",
  "company.address.line1": "your company address",
  "company.verification.document": "a company verification document",
  "external_account": "your bank account details",
  "individual.verification.document": "a photo ID",
  "individual.verification.additional_document": "an additional document",
  "representative.address.line1": "your address",
  "representative.dob.day": "your date of birth",
  "representative.dob.month": "your date of birth",
  "representative.dob.year": "your date of birth",
  "representative.email": "your email address",
  "representative.first_name": "your name",
  "representative.last_name": "your name",
  "representative.phone": "your phone number",
  "tos_acceptance.date": "acceptance of Stripe's terms",
};

export function describeRequirements(due: string[]): string[] {
  const described = due.map((key) => FRIENDLY[key]).filter((v): v is string => Boolean(v));
  return [...new Set(described)];
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface RequirementNudge {
  to: string;
  due: string[];
  disabledReason: string | null;
  /** Where the organiser goes to fix it. */
  payoutsUrl: string;
}

export function buildRequirementNudge(nudge: RequirementNudge): { subject: string; html: string; text: string } {
  const items = describeRequirements(nudge.due);
  // Stripe has already stopped something — say so, because the consequence is
  // no longer hypothetical.
  const blocked = Boolean(nudge.disabledReason);

  const subject = blocked
    ? "Action needed: your payouts are on hold"
    : "Stripe needs a bit more information from you";

  const lead = blocked
    ? "Stripe has paused payouts on your account until it gets some more information."
    : "Stripe needs some more information before your next payout can be sent.";

  const list = items.length > 0
    ? `<ul style="margin:0 0 20px;padding-left:20px;color:#e8e8e4;font-size:14px;line-height:1.7;">${
        items.map((i) => `<li>${escHtml(i)}</li>`).join("")
      }</ul>`
    : "";

  const textList = items.length > 0 ? items.map((i) => `  - ${i}`).join("\n") + "\n\n" : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:40px 16px;">
    <table width="100%" style="max-width:480px;margin:0 auto;background:#222;border:1px solid #333;border-radius:8px;">
      <tr><td style="padding:32px 28px;">
        <p style="margin:0 0 16px;color:#e8e8e4;font-size:16px;line-height:1.6;">${escHtml(lead)}</p>
        ${list}
        <p style="margin:0 0 24px;color:#9a9a94;font-size:14px;line-height:1.6;">
          You can add it from your payouts page. Stripe will ask you to sign in first — it holds
          these details, not WoCo.
        </p>
        <a href="${escHtml(nudge.payoutsUrl)}"
           style="display:inline-block;padding:12px 20px;background:#C7F23A;color:#0B0B09;
                  font-size:14px;font-weight:600;text-decoration:none;border-radius:4px;">
          Go to payouts
        </a>
      </td></tr>
    </table>
    <p style="max-width:480px;margin:16px auto 0;color:#6a6a64;font-size:12px;line-height:1.5;text-align:center;">
      Your money is safe. It stays with Stripe until this is resolved.
    </p>
  </td></tr></table>
</body>
</html>`;

  const text = `${lead}

${textList}Add it from your payouts page — Stripe will ask you to sign in first, as it holds these details rather than WoCo:

${nudge.payoutsUrl}

Your money is safe. It stays with Stripe until this is resolved.
`;

  return { subject, html, text };
}

export async function sendRequirementNudge(nudge: RequirementNudge): Promise<void> {
  const { subject, html, text } = buildRequirementNudge(nudge);
  await sendEmail(
    { from: getFromAddress(), to: [nudge.to], subject, html, text },
    { context: { kind: "stripe-requirement-nudge" } },
  );
}
