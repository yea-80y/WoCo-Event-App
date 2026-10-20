/**
 * Text colour for a button filled with a deployed site's accent.
 *
 * The WoCo app fixes `--accent-ink` in app.css because its accent is fixed. A
 * deployed site's accent is the organiser's choice - gold, purple, blue, lime - so
 * no single ink reads on all of them: white on the pub template's gold is 2.1:1.
 * The ink has to be picked per palette, and against the hover fill too, because a
 * tap on a phone leaves the button in its hover colour.
 */

export const DARK_INK = "#0B0B09";
export const LIGHT_INK = "#ffffff";

type Rgb = [number, number, number];

/** #rgb, #rgba, #rrggbb, #rrggbbaa or rgb()/rgba(). Anything else is null. */
export function parseColor(value: string): Rgb | null {
  const v = value.trim().toLowerCase();
  const hex = v.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join("");
    else if (h.length === 8) h = h.slice(0, 6);
    else if (h.length !== 6) return null;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
  }
  const rgb = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (rgb) return [rgb[1], rgb[2], rgb[3]].map((n) => Math.min(255, Number(n))) as Rgb;
  return null;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The ink that reads best on BOTH fills (the worse of its two contrasts is the
 * higher). A fill that cannot be parsed counts as absent; with neither, dark.
 */
export function accentInk(accent: string, accentHover?: string): string {
  const fills = [accent, accentHover].map((c) => (c ? parseColor(c) : null)).filter((c): c is Rgb => !!c);
  if (fills.length === 0) return DARK_INK;
  const worst = (ink: Rgb) => Math.min(...fills.map((f) => contrast(ink, f)));
  return worst(parseColor(LIGHT_INK)!) > worst(parseColor(DARK_INK)!) ? LIGHT_INK : DARK_INK;
}
