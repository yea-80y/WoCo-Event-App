import { PALETTES } from "./palette.js";

// System fonts only: a web font would be a download on every organiser page and
// a third-party request from their site, and the frame's CSP has no font-src.
// The WoCo look is carried by the palette, the square corners and the mono labels.
const SANS = `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
const MONO = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

// One rule per line where it fits: this string ships in the bundle as written,
// so CSS comments and indentation are bytes every buyer downloads. Notes on
// rules live here instead:
// - `.series-card > .claim-btn:disabled` is a card's status (sold out, ended,
//   cancelled), read as a label as on the event page; inside the buy panel a
//   disabled button is a paused action and only dims.
// - `.consent-block` is the buyer's ONLY disclosure on the organiser's site.
// - `.powered-by` is the app's mono kicker: tracked caps behind an accent square.
export function getStyles(theme: "dark" | "light"): string {
  const v = PALETTES[theme === "dark" ? "dark" : "light"];

  return `
:host { display: block; font-family: ${SANS}; line-height: 1.5; color: ${v.text}; -webkit-font-smoothing: antialiased; }
*, *::before, *::after { box-sizing: border-box; }
.woco-container { background: ${v.bg}; border: 1px solid ${v.border}; border-radius: 8px; padding: 1.25rem; max-width: 480px; }
.woco-header { display: flex; align-items: center; gap: 0.875rem; margin-bottom: 1rem; }
.woco-header img { width: 56px; height: 56px; border-radius: 4px; object-fit: cover; }
.woco-header h2 { margin: 0; font-size: 1.25rem; line-height: 1.2; font-weight: 700; letter-spacing: -0.01em; color: ${v.text}; }
.woco-header p { margin: 0.25rem 0 0; font: 0.75rem/1.45 ${MONO}; letter-spacing: 0.02em; color: ${v.textSecondary}; }
.ended-note { font-size: 0.8125rem; color: ${v.textSecondary}; background: ${v.warningBg}; border: 1px solid ${v.warningBorder}; border-left: 3px solid ${v.warning}; border-radius: 2px; padding: 0.625rem 0.75rem; margin: 0 0 0.75rem; }
.woco-desc { font-size: 0.8125rem; color: ${v.textSecondary}; line-height: 1.7; margin: 0 0 1rem; }
.series-card { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; padding: 0.875rem 1rem; border: 1px solid ${v.border}; border-radius: 2px; background: ${v.bgSurface}; margin-bottom: 0.5rem; }
.series-card:hover { border-color: ${v.borderHover}; }
.series-info h3 { margin: 0; font-size: 0.9375rem; font-weight: 600; color: ${v.text}; }
.series-info .avail { margin: 0.1875rem 0 0; font: 0.6875rem ${MONO}; letter-spacing: 0.02em; color: ${v.textMuted}; }
.claim-btn { padding: 0.5rem 1.125rem; font: 600 0.8125rem ${SANS}; border: 1px solid ${v.accentLine}; border-radius: 2px; background: ${v.accent}; color: ${v.accentInk}; cursor: pointer; white-space: nowrap; transition: background 0.12s; }
.claim-btn:hover:not(:disabled) { background: ${v.accentHover}; }
.claim-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.series-card > .claim-btn:disabled { opacity: 1; cursor: default; background: ${v.bgElevated}; color: ${v.textMuted}; border: 1px dashed ${v.border}; }
.error-msg { color: ${v.error}; font-size: 0.75rem; margin: 0.375rem 0 0; }
.consent-block { margin-top: 0.625rem; padding: 0.625rem 0.75rem; border: 1px solid ${v.border}; border-radius: 2px; background: ${v.bg}; }
.consent-block .transactional-note { font-size: 0.6875rem; color: ${v.textSecondary}; margin-bottom: 0.375rem; }
.consent-block .marketing-sentence { font-size: 0.71875rem; line-height: 1.45; color: ${v.text}; margin-bottom: 0.3125rem; }
.consent-block .consent-row { display: flex; align-items: flex-start; gap: 0.4375rem; cursor: pointer; font-size: 0.71875rem; line-height: 1.45; color: ${v.text}; }
.consent-block .consent-row input[type="checkbox"] { width: 0.8125rem; height: 0.8125rem; margin: 0.125rem 0 0; flex-shrink: 0; accent-color: ${v.accent}; }
.consent-block .privacy-note { margin-top: 0.4375rem; padding-top: 0.375rem; border-top: 1px solid ${v.border}; font-size: 0.6875rem; color: ${v.textSecondary}; }
.consent-block .privacy-note a { color: ${v.accentText}; }
.series-card.series-card--expanded { flex-direction: column; align-items: stretch; gap: 0; border-color: ${v.borderHover}; }
.order-form { display: flex; flex-direction: column; gap: 0.625rem; margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid ${v.border}; }
.form-field { display: flex; flex-direction: column; gap: 0.25rem; }
.form-label { font-size: 0.75rem; color: ${v.textSecondary}; font-weight: 500; }
.required, .field-error { color: ${v.error}; }
.field-note, .field-error { font-size: 0.6875rem; line-height: 1.35; }
.field-note { color: ${v.textMuted}; }
.order-form input, .order-form textarea, .order-form select { font: 0.875rem ${SANS}; padding: 0.5rem 0.625rem; background: ${v.inputBg}; border: 1px solid ${v.inputBorder}; border-radius: 2px; color: ${v.text}; outline: none; }
.order-form input:focus, .order-form textarea:focus, .order-form select:focus { border-color: ${v.accentLine}; box-shadow: 0 0 0 1px ${v.accentLine}; }
.checkbox-row { display: flex; align-items: center; gap: 0.375rem; cursor: pointer; font-size: 0.8125rem; color: ${v.textSecondary}; }
.checkbox-row input[type="checkbox"] { width: 0.875rem; height: 0.875rem; accent-color: ${v.accent}; }
.qty-row select { width: 5rem; font-weight: 600; }
.total-row { display: flex; align-items: baseline; gap: 0.5rem; font-size: 0.8125rem; color: ${v.textSecondary}; padding: 0.25rem 0; }
.total-row strong { font-size: 1rem; font-weight: 700; color: ${v.text}; font-variant-numeric: tabular-nums; }
.total-row .fee-note, .redirect-note, .encrypt-note { font-size: 0.6875rem; color: ${v.textMuted}; margin: 0; }
.seat-list { list-style: none; margin: 0; padding: 0; font: 0.75rem ${MONO}; color: ${v.text}; }
.seat-list li { padding: 0.125rem 0; }
.hold-slot:empty { display: none; }
.hold-pill { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.25rem 0.5rem; font: 600 0.6875rem ${MONO}; color: ${v.textSecondary}; background: ${v.bgElevated}; border: 1px solid ${v.border}; border-radius: 2px; }
.hold-dot { width: 5px; height: 5px; background: ${v.accentLine}; }
.hold-banner { font-size: 0.75rem; line-height: 1.45; padding: 0.5rem 0.625rem; border-radius: 2px; color: ${v.text}; background: ${v.warningBg}; border: 1px solid ${v.warningBorder}; }
.hold-retry { background: none; border: none; padding: 0; color: inherit; text-decoration: underline; cursor: pointer; font: inherit; }
.claim-options { display: flex; flex-direction: column; gap: 0.375rem; width: 100%; }
.claim-options .claim-btn { width: 100%; padding: 0.75rem 1rem; font-size: 0.875rem; border-radius: 4px; }
.form-actions { display: flex; gap: 0.5rem; justify-content: space-between; align-items: center; }
.cancel-btn { padding: 0.375rem 0; font: 0.8125rem ${SANS}; background: none; border: none; color: ${v.textMuted}; text-decoration: underline; text-underline-offset: 4px; cursor: pointer; }
.cancel-btn:hover { color: ${v.text}; }
.return-card { margin-bottom: 0.75rem; padding: 0.75rem 1rem; border: 1px solid ${v.border}; border-radius: 2px; background: ${v.bgSurface}; font-size: 0.8125rem; color: ${v.textSecondary}; }
.return-card--paid { border-color: ${v.accentLine}; border-left-width: 3px; }
.return-card p { margin: 0.25rem 0 0.5rem; }
.return-card strong, .return-title { color: ${v.text}; }
.return-title { font-size: 0.9375rem; font-weight: 600; }
.return-dismiss { padding: 0.375rem 0.75rem; font: 600 0.75rem ${SANS}; border: 1px solid ${v.border}; border-radius: 2px; background: none; color: ${v.text}; cursor: pointer; }
.return-dismiss:hover { border-color: ${v.accentLine}; }
.loading { text-align: center; padding: 2rem; font: 0.75rem ${MONO}; color: ${v.textMuted}; }
.powered-by { display: flex; justify-content: flex-end; align-items: center; gap: 0.5rem; margin-top: 1rem; font: 500 0.625rem ${MONO}; text-transform: uppercase; letter-spacing: 0.12em; color: ${v.textMuted}; }
.powered-by::before { content: ""; width: 0.375rem; height: 0.375rem; background: ${v.accentLine}; }
`;
}
