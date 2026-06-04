import type { Order, FiatCurrency } from "@woco/shared";
import { getResend, getFromAddress } from "./client.js";

const SYMBOLS: Record<string, string> = { GBP: "£", USD: "$", EUR: "€" };

function fmtMoney(amount: string, currency: FiatCurrency): string {
  const sym = SYMBOLS[currency] ?? currency;
  const n = parseFloat(amount);
  return Number.isFinite(n) ? `${sym}${n.toFixed(2)}` : `${sym}${amount}`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildReceiptHtml(
  shopName: string,
  order: Order,
  buyerEmail: string,
): string {
  const ccy = order.currency;
  const lineRows = order.lines
    .map(
      (l) =>
        `<tr>
          <td style="padding:8px 0;color:#e8e8e4;font-size:14px;">${escHtml(l.name)}</td>
          <td style="padding:8px 0;color:#9a9a94;font-size:13px;text-align:center;">×${l.qty}</td>
          <td style="padding:8px 0;color:#e8e8e4;font-size:14px;text-align:right;font-family:monospace;">${escHtml(fmtMoney(l.unitPrice, ccy))}</td>
        </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:40px 16px;">
    <table width="100%" style="max-width:480px;margin:0 auto;background:#222;border:1px solid #333;border-radius:8px;">
      <tr><td style="padding:32px 28px 24px;">
        <div style="display:inline-block;background:#c7f23a18;border:1px solid #c7f23a38;color:#c7f23a;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;padding:3px 10px;border-radius:2px;margin-bottom:16px;">Order confirmed</div>
        <h1 style="font-size:22px;font-weight:800;color:#f2ebe0;line-height:1.2;margin:0 0 6px;">${escHtml(shopName)}</h1>
        <p style="font-size:14px;color:#9a9a94;margin:0 0 24px;">Thank you — your order is ready to collect.</p>

        <!-- pickup code -->
        <div style="background:#111;border:1px solid #c7f23a44;border-radius:6px;padding:20px;text-align:center;margin-bottom:24px;">
          <div style="font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#9a9a94;margin-bottom:8px;">Pickup code</div>
          <div style="font-size:28px;font-weight:700;letter-spacing:0.14em;color:#c7f23a;font-family:monospace;">${escHtml(order.code)}</div>
          <div style="font-size:12px;color:#9a9a94;margin-top:8px;">Show this at the counter</div>
        </div>

        <!-- line items -->
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-top:1px solid #333;margin-bottom:8px;">
          ${lineRows}
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-top:1px solid #333;">
          <tr>
            <td style="padding:10px 0;font-size:14px;font-weight:700;color:#f2ebe0;">Total</td>
            <td></td>
            <td style="padding:10px 0;font-size:15px;font-weight:700;color:#f2ebe0;text-align:right;font-family:monospace;">${escHtml(fmtMoney(order.total, ccy))}</td>
          </tr>
        </table>

        <p style="margin:20px 0 0;font-size:11px;color:#9a9a94;line-height:1.5;">
          A Stripe receipt was also sent to ${escHtml(buyerEmail)}. If you need help, reply to this email or contact the shop directly.
        </p>
      </td></tr>
    </table>
  </td></tr></table>
</body>
</html>`;
}

export async function sendShopOrderEmail(opts: {
  to: string;
  shopName: string;
  order: Order;
}): Promise<void> {
  const resend = getResend();
  const fromAddress = getFromAddress();
  const { to, shopName, order } = opts;
  const totalStr = fmtMoney(order.total, order.currency);

  await resend.emails.send({
    from: `"${shopName.slice(0, 40)}" <${fromAddress}>`,
    to: [to],
    subject: `Your order ${order.code} — ${shopName} · ${totalStr}`,
    html: buildReceiptHtml(shopName, order, to),
  });
}
