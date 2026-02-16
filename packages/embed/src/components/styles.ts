export function getStyles(theme: "dark" | "light"): string {
  const isDark = theme === "dark";

  const vars = isDark
    ? {
        bg: "#09090f",
        bgSurface: "#12121e",
        bgSurfaceHover: "#191930",
        border: "#232340",
        borderHover: "#363660",
        text: "#eeeff5",
        textSecondary: "#a0a0b8",
        textMuted: "#6a6a80",
        accent: "#7c6cf0",
        accentHover: "#6b5ad8",
        accentText: "#a298f5",
        success: "#10b981",
        error: "#f43f5e",
        inputBg: "#0e0e1a",
      }
    : {
        bg: "#ffffff",
        bgSurface: "#f8f8fa",
        bgSurfaceHover: "#eeeff5",
        border: "#d1d5db",
        borderHover: "#9ca3af",
        text: "#111827",
        textSecondary: "#4b5563",
        textMuted: "#9ca3af",
        accent: "#7c6cf0",
        accentHover: "#6b5ad8",
        accentText: "#5b4ed4",
        success: "#059669",
        error: "#dc2626",
        inputBg: "#ffffff",
      };

  return `
    :host {
      display: block;
      font-family: "Inter", system-ui, -apple-system, sans-serif;
      line-height: 1.5;
      color: ${vars.text};
      -webkit-font-smoothing: antialiased;
    }

    *, *::before, *::after { box-sizing: border-box; }

    .woco-container {
      background: ${vars.bg};
      border: 1px solid ${vars.border};
      border-radius: 10px;
      padding: 1.25rem;
      max-width: 480px;
    }

    .woco-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1rem;
    }

    .woco-header img {
      width: 56px;
      height: 56px;
      border-radius: 8px;
      object-fit: cover;
    }

    .woco-header h2 {
      margin: 0;
      font-size: 1.125rem;
      font-weight: 600;
      color: ${vars.text};
    }

    .woco-header p {
      margin: 0.125rem 0 0;
      font-size: 0.8125rem;
      color: ${vars.textSecondary};
    }

    .woco-desc {
      font-size: 0.8125rem;
      color: ${vars.textSecondary};
      line-height: 1.6;
      margin: 0 0 0.75rem;
    }

    .series-card {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.75rem;
      border: 1px solid ${vars.border};
      border-radius: 8px;
      background: ${vars.bgSurface};
      margin-bottom: 0.5rem;
    }

    .series-info h3 {
      margin: 0;
      font-size: 0.9375rem;
      font-weight: 600;
      color: ${vars.text};
    }

    .series-info .avail {
      font-size: 0.75rem;
      color: ${vars.textMuted};
      margin: 0.125rem 0 0;
    }

    .claim-btn {
      padding: 0.5rem 1rem;
      font-size: 0.8125rem;
      font-weight: 600;
      border: none;
      border-radius: 6px;
      background: ${vars.accent};
      color: #fff;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s ease;
      font-family: inherit;
    }

    .claim-btn:hover:not(:disabled) {
      background: ${vars.accentHover};
    }

    .claim-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .claimed-badge {
      padding: 0.5rem 0.75rem;
      font-size: 0.8125rem;
      font-weight: 600;
      color: ${vars.success};
      border: 1px solid ${vars.success};
      border-radius: 6px;
      white-space: nowrap;
    }

    .email-form {
      display: flex;
      gap: 0.5rem;
      margin-top: 0.5rem;
    }

    .email-form input {
      flex: 1;
      padding: 0.5rem 0.625rem;
      font-size: 0.8125rem;
      border: 1px solid ${vars.border};
      border-radius: 6px;
      background: ${vars.inputBg};
      color: ${vars.text};
      font-family: inherit;
      outline: none;
    }

    .email-form input:focus {
      border-color: ${vars.accent};
    }

    .error-msg {
      color: ${vars.error};
      font-size: 0.75rem;
      margin: 0.375rem 0 0;
    }

    .loading {
      text-align: center;
      padding: 2rem;
      color: ${vars.textMuted};
      font-size: 0.875rem;
    }

    .powered-by {
      text-align: right;
      margin-top: 0.75rem;
      font-size: 0.6875rem;
      color: ${vars.textMuted};
    }

    .powered-by a {
      color: ${vars.accentText};
      text-decoration: none;
    }
  `;
}
