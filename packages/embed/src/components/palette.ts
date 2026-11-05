// Annotated so a colour missing from one theme fails the typecheck: the inferred
// union of the two literals typed it `string | undefined` and the light theme
// rendered `border: 1px solid undefined` (#1085).
// Hex only, never color-mix(): organiser pages run on browsers we do not choose.
export interface Palette {
  bg: string;
  bgSurface: string;
  bgElevated: string;
  border: string;
  borderHover: string;
  inputBg: string;
  inputBorder: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentHover: string;
  /** Text on an accent fill. */
  accentInk: string;
  /** The accent as a line or mark against bg: button edge, focus ring, paid border. */
  accentLine: string;
  /** The accent as text against bg: links. */
  accentText: string;
  warning: string;
  warningBg: string;
  warningBorder: string;
  error: string;
}

// Dark = the app's tokens (apps/web/src/app.css). The app has no light theme, so
// light is the same family on paper: bone ground, ink text, the lime kept as a
// fill under ink and darkened to olive wherever it is read against the ground.
// Checked to WCAG AA: text 4.5:1, lines 3:1.
export const PALETTES: Record<"dark" | "light", Palette> = {
  dark: {
    bg: "#0b0b09",
    bgSurface: "#14140f",
    bgElevated: "#1d1c17",
    border: "#2b2a23",
    borderHover: "#4a483d",
    inputBg: "#100f0c",
    // Not the app's hairline (1.3:1): a buyer on a stranger's site has to find the field.
    inputBorder: "#66625a",
    text: "#f2ebe0",
    textSecondary: "#b5ac9d",
    textMuted: "#8a8478",
    accent: "#c7f23a",
    accentHover: "#d6ff45",
    accentInk: "#0b0b09",
    accentLine: "#c7f23a",
    accentText: "#dcf560",
    warning: "#ffb020",
    warningBg: "#1f180b",
    warningBorder: "#604c22",
    error: "#ff5b2c",
  },
  light: {
    bg: "#f6f2ea",
    bgSurface: "#fbf9f4",
    bgElevated: "#efeadf",
    border: "#d8d0c1",
    borderHover: "#8a8170",
    inputBg: "#ffffff",
    inputBorder: "#958c7a",
    text: "#14140f",
    textSecondary: "#4a463d",
    textMuted: "#6e685c",
    accent: "#c7f23a",
    accentHover: "#b8e62a",
    accentInk: "#0b0b09",
    accentLine: "#6e8a00",
    accentText: "#4a5e00",
    warning: "#9a5b00",
    warningBg: "#f7e7ca",
    warningBorder: "#b26a00",
    error: "#c8381a",
  },
};
