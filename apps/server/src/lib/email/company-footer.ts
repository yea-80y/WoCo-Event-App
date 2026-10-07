/**
 * The company line every business email carries (UK trading disclosure, see
 * `@woco/shared` legal/company.ts). Transactional builders append it here;
 * marketing gets it through `marketing-footer.ts`, which every commercial
 * send must use.
 */

import { WOCO_COMPANY_LINE } from "@woco/shared";
import { escapeHtml } from "./marketing-footer.js";

/** One small line, in the email's own muted colour. */
export function companyFooterHtml(color: string): string {
  return `<p style="margin:8px 0 0;font-size:11px;line-height:1.5;color:${escapeHtml(color)};">${escapeHtml(WOCO_COMPANY_LINE)}</p>`;
}

/** The same line for a text/plain part. */
export function companyFooterText(): string {
  return `\n${WOCO_COMPANY_LINE}\n`;
}
