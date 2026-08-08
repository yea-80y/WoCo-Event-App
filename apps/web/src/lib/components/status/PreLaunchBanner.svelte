<!--
  PreLaunchBanner — the pre-launch status notice.

  Two lines stay visible and the detail hides behind a native <details>. That
  split is deliberate: the banner sits ABOVE the hero, so every line it holds
  open pushes the headline down — a four-line notice eats the whole first
  screen on a phone and the pitch never lands.

  The expanded panel leads with what already works rather than what is
  missing, so opening it reads as capability, not as an apology.

  <details> over a $state toggle: keyboard and screen-reader behaviour comes
  free, and it survives with JS still parsing.

  Two variants because the job differs by surface. "full" is the landing pitch,
  read once. "strip" is app chrome repeated on every screen, so it earns one
  line only — the standard environment-indicator pattern.

  DELETE AT LAUNCH — alongside flipping Stripe to live keys and revisiting
  FEATURES.cryptoPaymentsAllowed in packages/shared/src/features.ts.
-->
<script lang="ts">
  import BrandMark from "./BrandMark.svelte";

  interface Props {
    variant?: "full" | "strip";
  }
  let { variant = "full" }: Props = $props();

  const SOCIALS = [
    { brand: "x", label: "X", href: "https://x.com/woco_org" },
    { brand: "discord", label: "Discord", href: "https://discord.gg/BMtzDAuSX" },
  ] as const;
</script>

{#if variant === "strip"}
  <aside class="prelaunch prelaunch--strip" aria-label="Pre-launch status">
    <div class="inner strip-inner">
      <span class="kicker kicker--hi">PRE-LAUNCH</span>
      <span class="strip-text">
        Test mode — nothing here charges a real card.
      </span>
    </div>
  </aside>
{:else}
<aside class="prelaunch" aria-label="Pre-launch status">
  <div class="inner">
    <p class="headline">
      <!-- The system kicker, not a pulsing live-dot: a "live" signifier
           contradicts the one thing this banner exists to say. -->
      <span class="kicker kicker--hi">PRE-LAUNCH</span>
      <span class="claim">Real software, test money.</span>
    </p>

    <p class="sub">
      We're building in the open, with updates landing most days. Card payments
      switch on shortly, crypto rails soon after.
    </p>

    <div class="row">
      <details class="detail">
        <summary>What works right now</summary>
        <div class="detail-body">
          <p>
            Payments run through Stripe in test mode, and the on-chain pieces sit
            on Arbitrum Sepolia, a test network. Nothing moves real money — and no
            real card will work here yet.
          </p>
          <p>
            Everything else is already live: build an event, deploy a site on your
            own domain, issue cryptographically signed tickets, scan them at the door.
          </p>
          <p class="test-card">
            Want to try a checkout? Use Stripe's test card —
            <code>4242 4242 4242 4242</code>, any future expiry, any CVC.
          </p>
        </div>
      </details>

      <div class="contact">
        <span class="contact-ask">Organising an event? Talk to us</span>
        <span class="contact-links">
          {#each SOCIALS as social (social.href)}
            <a
              class="social"
              href={social.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="WoCo on {social.label} (opens in a new tab)"
            >
              <BrandMark brand={social.brand} size={16} />
            </a>
          {/each}
        </span>
      </div>
    </div>
  </div>
</aside>
{/if}

<style>
  .prelaunch {
    background:
      linear-gradient(to right, var(--accent-subtle), transparent 55%),
      var(--bg-surface);
    border-bottom: 1px solid var(--border);
  }
  .inner {
    max-width: 1100px;
    margin: 0 auto;
    padding: 0.875rem 1.5rem;
  }

  /* ── Strip variant ──────────────────────────────────────────────── */

  .strip-inner {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.25rem 0.625rem;
    padding-top: 0.5rem;
    padding-bottom: 0.5rem;
    max-width: none;
  }
  .strip-text {
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }

  .headline {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0;
    font-size: 0.9375rem;
  }
  .claim {
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.01em;
  }

  .sub {
    margin: 0.375rem 0 0;
    font-size: 0.875rem;
    line-height: 1.5;
    color: var(--text-secondary);
    max-width: 68ch;
  }
  /* Disclosure and contact share one row so the banner costs three lines,
     not four — the hero has to survive above the fold on a phone. */
  .row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem 1.5rem;
    margin-top: 0.625rem;
  }

  .contact {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    font-size: 0.8125rem;
    color: var(--text-muted);
  }
  .contact-links { display: flex; gap: 0.375rem; }

  /* Mark alone — "Talk to us" already labels the row, so a wordmark beside the
     X glyph would only repeat it. The pill carries the touch target the bare
     16px mark cannot. */
  .social {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    text-decoration: none;
    transition:
      color var(--transition),
      border-color var(--transition),
      background var(--transition);
  }
  .social:hover {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-subtle);
  }
  .social:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }

  /* ── Disclosure ─────────────────────────────────────────────────── */

  .detail summary {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-muted);
    cursor: pointer;
    list-style: none;
    transition: color var(--transition);
  }
  .detail summary::-webkit-details-marker { display: none; }
  .detail summary::after {
    content: "→";
    transition: transform var(--transition);
  }
  .detail[open] summary::after { transform: rotate(90deg); }
  .detail summary:hover { color: var(--accent); }
  .detail summary:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 3px;
  }

  .detail-body {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px dashed var(--border);
    max-width: 68ch;
  }
  .detail-body p {
    margin: 0 0 0.625rem;
    font-size: 0.875rem;
    line-height: 1.6;
    color: var(--text-secondary);
  }
  .detail-body p:last-child { margin-bottom: 0; }

  .test-card { color: var(--text-muted); }
  .test-card code {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    color: var(--accent-text);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.125rem 0.375rem;
    white-space: nowrap;
  }

  @media (max-width: 640px) {
    .inner { padding: 0.75rem 1.25rem; }
    .headline { font-size: 0.875rem; }
    .sub { font-size: 0.8125rem; }
  }

  @media (prefers-reduced-motion: reduce) {
    .detail summary::after { transition: none; }
  }
</style>
