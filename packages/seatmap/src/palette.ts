/**
 * Every colour and font the seat map draws with. Nothing in the renderer is
 * hard-coded, so the same drawing takes the WoCo app's tokens, an organiser's
 * website theme, or the page an embed sits on.
 *
 * Price bands are told apart by TONE and TEXTURE, never by hue alone: one solid
 * light, one solid mid, an outline, a hatch, dots, a dashed outline... The one
 * signal colour (`accent`) means a single thing on any map: what the person
 * looking at it has chosen.
 */

export interface SeatmapPalette {
  bg: string;
  surface: string;
  elevated: string;
  line: string;
  lineStrong: string;
  text: string;
  text2: string;
  muted: string;
  dim: string;
  accent: string;
  accentInk: string;
  fontUi: string;
  fontMono: string;
}

/** The WoCo app ("Concrete & Acid"); mirrors `apps/web/src/app.css`. */
export const APP_PALETTE: SeatmapPalette = {
  bg: "#0B0B09",
  surface: "#14140F",
  elevated: "#1D1C17",
  line: "#2B2A23",
  lineStrong: "#4A483D",
  text: "#F2EBE0",
  text2: "#B5AC9D",
  muted: "#8A8478",
  dim: "#55524A",
  accent: "#C7F23A",
  accentInk: "#0B0B09",
  fontUi: '"Space Grotesk", system-ui, sans-serif',
  fontMono: '"JetBrains Mono", ui-monospace, monospace',
};

/**
 * The app palette read from CSS custom properties on `el` (the app's tokens), so a
 * token change reaches the map. Falls back per value to APP_PALETTE.
 */
export function paletteFromCss(el: Element): SeatmapPalette {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: v("--bg", APP_PALETTE.bg),
    surface: v("--bg-surface", APP_PALETTE.surface),
    elevated: v("--bg-elevated", APP_PALETTE.elevated),
    line: v("--border", APP_PALETTE.line),
    lineStrong: v("--border-hover", APP_PALETTE.lineStrong),
    text: v("--text", APP_PALETTE.text),
    text2: v("--text-secondary", APP_PALETTE.text2),
    muted: v("--text-muted", APP_PALETTE.muted),
    dim: v("--text-dim", APP_PALETTE.dim),
    accent: v("--accent", APP_PALETTE.accent),
    accentInk: v("--accent-ink", APP_PALETTE.accentInk),
    fontUi: v("--font-body", APP_PALETTE.fontUi),
    fontMono: v("--font-mono", APP_PALETTE.fontMono),
  };
}

export type BandFillKind = "solid" | "outline" | "hatch" | "dots" | "dashed" | "cross";

export interface BandStyle {
  kind: BandFillKind;
  /** The colour of the fill or the line. */
  tone: string;
  /** What reads on top of it (a wheelchair mark). */
  ink: string;
}

/** The fill for band style `k` (0..7, `SeatBand.style`). */
export function bandStyle(p: SeatmapPalette, k: number): BandStyle {
  const styles: BandStyle[] = [
    { kind: "solid", tone: p.text, ink: p.bg },
    { kind: "solid", tone: p.muted, ink: p.bg },
    { kind: "outline", tone: p.text, ink: p.text },
    { kind: "hatch", tone: p.text2, ink: p.text },
    { kind: "dots", tone: p.text, ink: p.text },
    { kind: "dashed", tone: p.text, ink: p.text },
    { kind: "solid", tone: p.text2, ink: p.bg },
    { kind: "cross", tone: p.muted, ink: p.text },
  ];
  return styles[((k % styles.length) + styles.length) % styles.length];
}
