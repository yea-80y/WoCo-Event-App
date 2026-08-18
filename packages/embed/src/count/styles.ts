/**
 * Two sizes of one artifact: a figure composited onto a live video stream, and
 * a card dropped into somebody else's marketing page.
 *
 * BROADCAST LEGIBILITY IS THE CONSTRAINT ON THE OVERLAY. It sits over footage
 * nobody has seen yet — bright sky, dark queue line, a moving train — so the
 * figure carries its own contrast rather than borrowing any from a background
 * it cannot paint. That is a dark stroke plus a shadow, not a panel: a panel
 * would be a box on the composition, which is the first thing a broadcaster
 * asks to remove.
 *
 * `font-variant-numeric: tabular-nums` is not a nicety here. Proportional
 * digits change width as the count ticks, so the whole figure jitters on screen
 * every time a lap lands — on a static overlay that reads as a glitch.
 *
 * NO WEB FONT. OBS renders in its own CEF build with whatever fonts the machine
 * has, and the overlay is designed to run as a local file with no network
 * dependency for its shell. A font that fails to arrive would reflow the figure
 * mid-broadcast, which is worse than any typeface choice.
 */

/** WoCo's acid lime — the accent across the platform UI. */
const ACID = "#C7F23A";

export function overlayStyles(): string {
  return `
    :host {
      display: block;
      /* No background: OBS composites this over video and paints transparency
         behind it. Anything opaque here becomes a box on the broadcast. */
      background: transparent;
      font-family: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
      color: #ffffff;
    }

    *, *::before, *::after { box-sizing: border-box; }

    .wrap {
      display: inline-flex;
      flex-direction: column;
      gap: 0.1em;
      padding: 0.4em 0.6em;
      line-height: 1.05;
      /* Carried on the container so every child inherits the same contrast
         treatment over unknown footage. */
      text-shadow:
        0 0 0.08em rgba(0, 0, 0, 0.95),
        0 0.04em 0.12em rgba(0, 0, 0, 0.8),
        0 0 0.4em rgba(0, 0, 0, 0.5);
    }

    .kicker {
      font-size: 0.9rem;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: ${ACID};
      /* Explicit px, not the container's em-based shadow: that one scales with
         font-size, so on text this small it renders as almost nothing and the
         lime disappears against a bright sky. Verified against sky, dark
         foliage and high-contrast clutter. */
      text-shadow:
        0 0 2px rgba(0, 0, 0, 1),
        0 1px 2px rgba(0, 0, 0, 0.95),
        0 0 6px rgba(0, 0, 0, 0.7);
      -webkit-text-stroke: 0.4px rgba(0, 0, 0, 0.45);
    }

    .figure {
      display: flex;
      align-items: baseline;
      gap: 0.22em;
      font-weight: 800;
      font-size: 4.2rem;
      font-variant-numeric: tabular-nums;
      /* A stroke under the shadow: the shadow handles soft backgrounds, the
         stroke handles a bright one where a shadow alone disappears. */
      -webkit-text-stroke: 0.02em rgba(0, 0, 0, 0.55);
    }

    .unit {
      font-size: 0.3em;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: lowercase;
      -webkit-text-stroke: 0;
    }

    .sub {
      display: flex;
      align-items: center;
      gap: 0.5em;
      font-size: 0.85rem;
      font-weight: 600;
      color: #ffffff;
      text-shadow:
        0 0 2px rgba(0, 0, 0, 1),
        0 1px 2px rgba(0, 0, 0, 0.95),
        0 0 6px rgba(0, 0, 0, 0.7);
    }

    .coaster { white-space: nowrap; }

    /* Sustained failure dims the figure rather than removing it. A number
       vanishing mid-broadcast is worse than an old one; an unmarked old one is
       worse than both.

       Only slightly dimmed, deliberately. At 0.55 the figure all but vanished
       against bright footage, which reads as a broken render rather than as a
       deliberate mark — and a viewer who thinks the graphic is broken has
       learned nothing about the count. The BADGE carries the meaning; the dim
       only supports it. */
    .wrap.stale .figure,
    .wrap.stale .kicker { opacity: 0.72; }

    /* A pill, not bare text. This is the one element that must be readable over
       footage nobody has seen, because it is what stops an old number being
       read as a current one — a shadow alone loses it against a bright sky. */
    .stale-mark {
      display: none;
      align-items: center;
      gap: 0.35em;
      font-size: 0.8rem;
      font-weight: 700;
      color: #ffd166;
      background: rgba(0, 0, 0, 0.78);
      padding: 0.2em 0.55em;
      border-radius: 999px;
      align-self: flex-start;
      margin-top: 0.15em;
    }
    .wrap.stale .stale-mark { display: inline-flex; }

    .dot {
      width: 0.5em;
      height: 0.5em;
      border-radius: 50%;
      background: currentColor;
      flex: none;
    }
  `;
}

export function cardStyles(theme: "dark" | "light"): string {
  const isDark = theme === "dark";
  const v = isDark
    ? {
        bg: "#09090f",
        border: "#232340",
        text: "#eeeff5",
        textSecondary: "#a0a0b8",
        textMuted: "#6a6a80",
        link: ACID,
        warn: "#ffd166",
      }
    : {
        bg: "#ffffff",
        border: "#d1d5db",
        text: "#111827",
        textSecondary: "#4b5563",
        textMuted: "#9ca3af",
        link: "#4a7c00",
        warn: "#92400e",
      };

  return `
    :host {
      display: block;
      font-family: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
      color: ${v.text};
    }

    *, *::before, *::after { box-sizing: border-box; }

    .wrap {
      background: ${v.bg};
      border: 1px solid ${v.border};
      border-radius: 12px;
      padding: 1.25rem 1.4rem;
      max-width: 420px;
    }

    .kicker {
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: ${v.textSecondary};
      margin-bottom: 0.35rem;
    }

    .figure {
      display: flex;
      align-items: baseline;
      gap: 0.25rem;
      font-weight: 800;
      font-size: 2.75rem;
      line-height: 1.05;
      font-variant-numeric: tabular-nums;
    }

    .unit {
      font-size: 1rem;
      font-weight: 600;
      color: ${v.textSecondary};
    }

    .sub {
      margin-top: 0.15rem;
      font-size: 0.85rem;
      color: ${v.textSecondary};
    }

    .line {
      margin-top: 0.85rem;
      font-size: 0.875rem;
      line-height: 1.5;
      color: ${v.textSecondary};
    }

    .note {
      margin-top: 0.5rem;
      font-size: 0.8rem;
      line-height: 1.45;
      color: ${v.warn};
    }

    .stale-mark {
      display: none;
      align-items: center;
      gap: 0.4rem;
      margin-top: 0.5rem;
      font-size: 0.8rem;
      font-weight: 600;
      color: ${v.warn};
    }
    .wrap.stale .stale-mark { display: flex; }
    /* Dimmed harder than the overlay's 0.72, and deliberately: this card owns
       its own background, so the figure cannot disappear into footage the way
       it did over a bright sky. The asymmetry is the point, not an oversight. */
    .wrap.stale .figure { opacity: 0.55; }

    .dot {
      width: 0.45rem;
      height: 0.45rem;
      border-radius: 50%;
      background: currentColor;
      flex: none;
    }

    .actions { margin-top: 0.9rem; }

    a.verify {
      display: inline-block;
      font-size: 0.85rem;
      font-weight: 600;
      color: ${v.link};
      text-decoration: none;
      border-bottom: 1px solid currentColor;
      padding-bottom: 1px;
    }
    a.verify:hover { opacity: 0.8; }

    .mark {
      margin-top: 0.9rem;
      font-size: 0.7rem;
      letter-spacing: 0.04em;
      color: ${v.textMuted};
    }

    .empty {
      font-size: 0.95rem;
      color: ${v.textMuted};
      font-variant-numeric: tabular-nums;
    }
  `;
}
