/** Icons for the builder's "Add to the room" tiles and seat marks. `currentColor`, so the host styles them. */

const sq = (x: number, y: number) => `<rect x="${Math.round(x * 100) / 100}" y="${Math.round(y * 100) / 100}" width="4" height="4" rx=".6"/>`;

export const ADD_ICONS = {
  rows: `<svg width="44" height="28" viewBox="0 0 44 28" aria-hidden="true"><g fill="currentColor">${[5, 12, 19].map((y) => [4, 10, 16, 24, 30, 36].map((x) => sq(x, y)).join("")).join("")}</g></svg>`,
  round: `<svg width="44" height="28" viewBox="0 0 44 28" aria-hidden="true"><circle cx="22" cy="14" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/><g fill="currentColor">${Array.from({ length: 8 }, (_, i) => { const a = -Math.PI / 2 + (i * Math.PI) / 4; return sq(22 + 11 * Math.cos(a) - 2, 14 + 11 * Math.sin(a) - 2); }).join("")}</g></svg>`,
  long: `<svg width="44" height="28" viewBox="0 0 44 28" aria-hidden="true"><rect x="9" y="10.5" width="26" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><g fill="currentColor">${[12, 20, 28].map((x) => sq(x, 3) + sq(x, 21)).join("")}</g></svg>`,
  head: `<svg width="44" height="28" viewBox="0 0 44 28" aria-hidden="true"><rect x="7" y="14" width="30" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><g fill="currentColor">${[9, 16, 23, 30].map((x) => sq(x, 6)).join("")}</g></svg>`,
  stage: `<svg width="44" height="28" viewBox="0 0 44 28" aria-hidden="true"><rect x="6" y="8" width="32" height="12" rx="1.5" fill="currentColor"/></svg>`,
  bar: `<svg width="44" height="28" viewBox="0 0 44 28" aria-hidden="true"><rect x="6" y="9" width="32" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`,
  ring: `<svg width="44" height="28" viewBox="0 0 44 28" aria-hidden="true"><rect x="12" y="3" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="15.5" y="6.5" width="13" height="13" fill="none" stroke="currentColor" stroke-width=".8" opacity=".6"/><g fill="currentColor"><rect x="10" y="1" width="4" height="4"/><rect x="30" y="1" width="4" height="4"/><rect x="10" y="21" width="4" height="4"/><rect x="30" y="21" width="4" height="4"/></g></svg>`,
  pitch: `<svg width="44" height="28" viewBox="0 0 44 28" aria-hidden="true"><g fill="none" stroke="currentColor"><rect x="5" y="4" width="34" height="20" rx="1" stroke-width="1.3"/><path d="M22 4v20" stroke-width=".9"/><circle cx="22" cy="14" r="3.5" stroke-width=".9"/></g></svg>`,
  floor: `<svg width="44" height="28" viewBox="0 0 44 28" aria-hidden="true"><rect x="8" y="4" width="28" height="20" rx="1.5" fill="none" stroke="currentColor" stroke-dasharray="2.5 2"/><path d="M14 24l12-20M22 24l12-20M8 18l8.5-14" stroke="currentColor" opacity=".45"/></svg>`,
  label: `<svg width="44" height="28" viewBox="0 0 44 28" aria-hidden="true"><text x="22" y="19" text-anchor="middle" font-size="14" font-weight="600" fill="currentColor">Aa</text></svg>`,
} as const;

export const MARK_ICONS = {
  held: `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect x="2" y="2" width="14" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4 14L14 4M2.5 9.5l7-7M8.5 15.5l7-7" stroke="currentColor" stroke-width="1.1"/></svg>`,
  wheel: `<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="3.2" r="1.6" fill="currentColor"/><path d="M7.6 5.2v4.2h3.4l1.4 2.8M6 7.4a3.4 3.4 0 1 0 4.8 3.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  companion: `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect x="2" y="2" width="14" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="12" cy="6" r="2" fill="currentColor"/></svg>`,
  gap: `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect x="3" y="3" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-dasharray="2.5 2"/></svg>`,
} as const;
