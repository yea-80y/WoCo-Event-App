/**
 * The seat map frame's colours: the widget's own dark and light themes
 * (components/styles.ts), given the CSS variable names the shared SeatPicker and the
 * map renderer read (`paletteFromCss`).
 */
export function frameThemeCss(theme: "dark" | "light"): string {
  const v = theme === "dark"
    ? {
      bg: "#09090f", surface: "#12121e", elevated: "#191930", border: "#232340", borderHover: "#363660",
      text: "#eeeff5", text2: "#a0a0b8", muted: "#6a6a80", dim: "#45455c",
      accent: "#7c6cf0", accentHover: "#6b5ad8", accentText: "#a298f5", accentInk: "#ffffff", accentSubtle: "rgba(124,108,240,0.14)",
    }
    : {
      bg: "#ffffff", surface: "#f8f8fa", elevated: "#eeeff5", border: "#d1d5db", borderHover: "#9ca3af",
      text: "#111827", text2: "#4b5563", muted: "#6b7280", dim: "#c4c8d0",
      accent: "#7c6cf0", accentHover: "#6b5ad8", accentText: "#5b4ed4", accentInk: "#ffffff", accentSubtle: "rgba(124,108,240,0.10)",
    };
  return `
:root {
  --bg: ${v.bg}; --bg-surface: ${v.surface}; --bg-elevated: ${v.elevated};
  --border: ${v.border}; --border-hover: ${v.borderHover};
  --text: ${v.text}; --text-secondary: ${v.text2}; --text-muted: ${v.muted}; --text-dim: ${v.dim};
  --accent: ${v.accent}; --accent-hover: ${v.accentHover}; --accent-text: ${v.accentText}; --accent-ink: ${v.accentInk};
  --accent-subtle: ${v.accentSubtle};
  --radius-sm: 4px; --radius-md: 8px; --radius-lg: 12px;
  --font-body: "Inter", system-ui, -apple-system, sans-serif; --font-mono: ui-monospace, "SF Mono", Menlo, monospace;
}
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: var(--font-body); }
*, *::before, *::after { box-sizing: border-box; }
`;
}
