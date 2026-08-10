<!--
  Splitter — the root landing at /.
  Funnels visitors to either the organiser or attendee surface.
  Design spec: memory/project_ui_theming_direction.md ("Own your scene.")
-->
<script lang="ts">
  import { navigate } from "../router/router.svelte.js";
  import { loginRequest } from "../auth/login-request.svelte.js";
  import { auth } from "../auth/auth-store.svelte.js";
  import TicketStub from "../components/icons/sprites/TicketStub.svelte";
  import DoorOpen from "../components/icons/sprites/DoorOpen.svelte";
  import SprayCan from "../components/icons/sprites/SprayCan.svelte";
  import WocoWordmark from "../components/brand/WocoWordmark.svelte";
  import PreLaunchBanner from "../components/status/PreLaunchBanner.svelte";
  import ArrowRight from "lucide-svelte/icons/arrow-right";
  import Shield from "lucide-svelte/icons/shield-check";
  // Two photographs, two jobs. `crowd` is screen-blended so its pure-black
  // pixels resolve to exactly --bg and the frame dissolves — it is a light
  // source, not a picture. `decks` is the opposite: a hard-edged plate, held
  // under 420px so it never upscales past its native 1080px and goes soft.
  import crowdAvif from "./media/crowd.avif";
  import crowdWebp from "./media/crowd.webp";
  import crowdJpg from "./media/crowd.jpg";
  import decksAvif from "./media/decks.avif";
  import decksWebp from "./media/decks.webp";
  import decksJpg from "./media/decks.jpg";
  import Layers from "lucide-svelte/icons/layers";
  import Coins from "lucide-svelte/icons/coins";
  import HomeIcon from "lucide-svelte/icons/house";
  import Users from "lucide-svelte/icons/users-round";
</script>

<div class="root">
  <PreLaunchBanner />

  <!-- ── Top bar ─────────────────────────────────────────────────────── -->
  <header class="top">
    <button class="brand" onclick={() => navigate("/")} aria-label="WoCo home">
      <WocoWordmark height={22} variant="default" />
    </button>
    <nav class="top-nav">
      <button class="link" onclick={() => navigate("/discover")}>Discover</button>
      <button class="link" onclick={() => navigate("/creator")}>Creator portal</button>
      {#if auth.isConnected}
        <button class="btn btn--ghost btn-sm" onclick={() => navigate("/soon/tickets")}>My tickets</button>
      {:else}
        <button class="btn btn--ghost btn-sm" onclick={() => loginRequest.request()}>Sign in</button>
      {/if}
    </nav>
  </header>

  <!-- ── Hero ────────────────────────────────────────────────────────── -->
  <section class="hero scanlines grain">
    <div class="hero-light" aria-hidden="true">
      <picture>
        <source srcset={crowdAvif} type="image/avif" />
        <source srcset={crowdWebp} type="image/webp" />
        <img src={crowdJpg} alt="" decoding="async" />
      </picture>
    </div>

    <div class="hero-inner">
      <div class="hero-kicker">
        <span class="live-dot" aria-hidden="true"></span>
        <span class="mono-kicker">// THE EVENT PLATFORM YOU ACTUALLY OWN</span>
      </div>

      <h1 class="hero-headline">
        Own your <span class="tag-display headline-tag">scene</span>.
      </h1>

      <p class="hero-sub">
        The full event stack — ticketing, sites, payments, audience —
        owned by you, not us. Built so creators and venues can keep
        every part of the night they make.
      </p>

      <div class="hero-ctas">
        <button class="cta cta--primary" onclick={() => navigate("/creator")}>
          <span class="cta-sprite">
            <TicketStub size={32} color="currentColor" />
          </span>
          <span class="cta-body">
            <span class="cta-label">I run events</span>
            <span class="cta-sub">Create, deploy, sell tickets</span>
          </span>
          <span class="cta-arrow"><ArrowRight size={20} strokeWidth={2.25} /></span>
        </button>

        <button class="cta cta--ghost" onclick={() => navigate("/discover")}>
          <span class="cta-sprite">
            <DoorOpen size={32} color="currentColor" />
          </span>
          <span class="cta-body">
            <span class="cta-label">I'm here for a show</span>
            <span class="cta-sub">Find events, claim tickets</span>
          </span>
          <span class="cta-arrow"><ArrowRight size={20} strokeWidth={2.25} /></span>
        </button>
      </div>

      <div class="hero-meta">
        <span class="mono-kicker">DECENTRALISED</span>
        <span class="dot">·</span>
        <span class="mono-kicker">OPEN STANDARDS</span>
        <span class="dot">·</span>
        <span class="mono-kicker">YOURS TO LEAVE</span>
      </div>
    </div>

    <!-- corner stamps -->
    <div class="corner corner-tl mono">EST. 2025 · PRE-LAUNCH</div>
    <div class="corner corner-br mono">v0 // YOURS TO LEAVE</div>
  </section>

  <!-- ── Section divider ─────────────────────────────────────────────── -->
  <div class="divider">
    <span class="divider-tag tag-display">Five reasons</span>
    <span class="divider-line"></span>
    <span class="mono-kicker">// WHY ORGANISERS BUILD HERE</span>
  </div>

  <!-- ── USP blocks — alternating editorial rhythm ───────────────────── -->
  <section class="usps">

    <!-- 01 -->
    <article class="usp usp--left">
      <div class="usp-num mono">01</div>
      <div class="usp-body">
        <span class="usp-icon"><HomeIcon size={22} strokeWidth={2.25} /></span>
        <h2>Your event, your house.</h2>
        <p>
          Run it on your own domain. Keep your audience, your brand,
          your community — not someone else's email list. The platform
          is a toolkit you use, not a landlord you pay rent to.
        </p>
      </div>
    </article>

    <!-- 02 -->
    <article class="usp usp--right">
      <div class="usp-num mono">02</div>
      <div class="usp-body">
        <span class="usp-icon"><Coins size={22} strokeWidth={2.25} /></span>
        <h2>Keep more of what you sell.</h2>
        <p>
          Booking fees fund platforms. Ours doesn't. Price the ticket;
          charge what's fair. The economics of your night should belong
          to you and the room — not to a logo in a corner.
        </p>
      </div>
    </article>

    <!-- 03 -->
    <article class="usp usp--left">
      <div class="usp-num mono">03</div>
      <div class="usp-body">
        <span class="usp-icon"><Shield size={22} strokeWidth={2.25} /></span>
        <h2>Every ticket, provably real.</h2>
        <p>
          Cryptographically signed the moment it's issued.
          Counterfeit-proof, dispute-proof, screenshot-proof.
          Door staff scan once and know. No more "we can't find your order."
        </p>
      </div>
    </article>

    <!-- 04 -->
    <article class="usp usp--right">
      <div class="usp-num mono">04</div>
      <div class="usp-body">
        <span class="usp-icon"><Layers size={22} strokeWidth={2.25} /></span>
        <h2>Tickets your attendees actually own.</h2>
        <p>
          A ticket should be a keepsake, not a receipt. Yours forever —
          a stub from the night, proof you were there, the key to
          whatever comes next. Built on open standards so they're
          really, properly yours.
        </p>
      </div>
    </article>

    <!-- 05 -->
    <article class="usp usp--left">
      <div class="usp-num mono">05</div>
      <div class="usp-body">
        <span class="usp-icon"><Users size={22} strokeWidth={2.25} /></span>
        <h2>A community that follows you home.</h2>
        <p>
          Every ticket is a thread back to your audience. Reward returning
          fans, drop perks for early supporters, build a membership loop
          that doesn't reset to zero after every event.
        </p>
      </div>
    </article>

  </section>

  <!-- ── Closing CTA strip ───────────────────────────────────────────── -->
  <section class="closing">
    <div class="closing-grid">
      <figure class="closing-plate">
        <picture>
          <source srcset={decksAvif} type="image/avif" />
          <source srcset={decksWebp} type="image/webp" />
          <img src={decksJpg} alt="" loading="lazy" decoding="async" />
        </picture>
      </figure>

      <div class="closing-text">
        <SprayCan size={42} color="var(--text)" paintColor="var(--accent)" />
        <h2>Ready to build something the platform can't take from you?</h2>
        <p>
          Free to start. Your data, your audience, your call. Leave any
          time and your events come with you.
        </p>
        <div class="closing-actions">
          <button class="btn btn--primary btn--lg" onclick={() => navigate("/creator")}>
            Open the creator portal
            <ArrowRight size={18} strokeWidth={2.5} />
          </button>
          <button class="link link-quiet" onclick={() => navigate("/discover")}>
            or browse events on the platform →
          </button>
        </div>
      </div>
    </div>
  </section>

  <!-- ── Footer ──────────────────────────────────────────────────────── -->
  <footer class="footer">
    <div class="footer-grid">
      <div class="footer-brand">
        <WocoWordmark height={28} variant="ink" />
        <p class="footer-line">Decentralised event infrastructure.</p>
      </div>
      <div class="footer-cols">
        <div class="footer-col">
          <span class="mono-kicker">Platform</span>
          <button class="link" onclick={() => navigate("/discover")}>Discover events</button>
          <button class="link" onclick={() => navigate("/creator")}>Creator portal</button>
          <button class="link" onclick={() => navigate("/soon/tickets")}>My tickets</button>
        </div>
      </div>
    </div>
    <div class="footer-fine mono">© 2026 · BUILT ON OPEN RAILS · LEAVE WHENEVER</div>
  </footer>
</div>

<style>
  /* ── Layout shell ───────────────────────────────────────────────── */

  .root {
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
  }

  /* ── Top bar ────────────────────────────────────────────────────── */

  .top {
    max-width: 1200px;
    margin: 0 auto;
    padding: 1.25rem 1.5rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    transition: transform var(--transition-fast);
  }
  .brand:hover { transform: translate(-1px, -1px); }
  .top-nav { display: flex; align-items: center; gap: 1.5rem; }
  .link {
    font-family: var(--font-body);
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text-secondary);
    background: none;
    border: none;
    padding: 0.25rem 0;
    transition: color var(--transition);
    border-bottom: 1px solid transparent;
  }
  .link:hover { color: var(--accent); border-bottom-color: var(--accent); }
  .link-quiet { color: var(--text-muted); }
  .btn-sm { padding: 0.5rem 0.875rem; font-size: 0.8125rem; }

  @media (max-width: 640px) {
    .top-nav { gap: 0.875rem; }
    .top-nav .link:nth-child(1) { display: none; }
  }

  /* ── Hero ──────────────────────────────────────────────────────── */

  .hero {
    position: relative;
    padding: 4rem 1.5rem 5rem;
    border-bottom: 1px solid var(--border);
    overflow: hidden;
    /* Required, not cosmetic: .scanlines sets `isolation: isolate`, so the
       hero is its own blending group. Without an explicit backdrop the
       screen-blended light layer composites against transparency and its
       blacks render as black rectangles instead of dissolving. */
    background: var(--bg);
    display: flex;
    align-items: center;
    min-height: clamp(540px, 72vh, 780px);
  }
  .hero-inner {
    position: relative;
    max-width: 1100px;
    margin: 0 auto;
    width: 100%;
    z-index: 2;
  }

  /* ── Hero light — the crowd photograph as a light source ──────────────
     Screen blend against --bg makes every true-black pixel resolve to the
     page background exactly, so the photo has no edges at all: only the
     beams survive. Spills in from the right, where the headline isn't. */

  .hero-light {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(64%, 900px);
    z-index: 0;
    pointer-events: none;
    mix-blend-mode: screen;
    /* Two feathers, intersected: one pulls the light off the headline on the
       left, one keeps the beams from being guillotined by the hero's top and
       bottom borders. Without the vertical one the light ends on a visible
       horizontal seam and the whole effect reads as a pasted rectangle. */
    -webkit-mask-image:
      linear-gradient(to right, transparent 0%, rgba(0, 0, 0, 0.3) 24%, #000 64%),
      linear-gradient(to bottom, transparent 0%, #000 28%, #000 74%, transparent 100%);
    -webkit-mask-composite: source-in;
    mask-image:
      linear-gradient(to right, transparent 0%, rgba(0, 0, 0, 0.3) 24%, #000 64%),
      linear-gradient(to bottom, transparent 0%, #000 28%, #000 74%, transparent 100%);
    mask-composite: intersect;
  }
  .hero-light picture {
    display: block;
    width: 100%;
    height: 100%;
    /* One source of truth for how bright the room is — the keyframes read
       these rather than repeating literals that drift out of step. */
    --lit: 0.68;
    --lit-peak: 0.8;
    opacity: var(--lit);
    /* The house lights come up once on load, then breathe. One deliberate
       motion; the rest of the page is still. */
    animation:
      house-lights 1500ms cubic-bezier(0.22, 0.7, 0.2, 1) both,
      light-breathe 15s ease-in-out 1500ms infinite;
  }
  .hero-light img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    /* Holds the light burst high and right, clear of the headline and the
       CTA pair below it. */
    object-position: 46% 58%;
  }

  @keyframes house-lights {
    from { opacity: 0; transform: scale(1.05); }
    to   { opacity: var(--lit); transform: scale(1); }
  }
  @keyframes light-breathe {
    0%, 100% { opacity: var(--lit); }
    50%      { opacity: var(--lit-peak); }
  }
  @media (prefers-reduced-motion: reduce) {
    .hero-light picture { animation: none; opacity: var(--lit); }
  }

  /* Below desktop the text column claims most of the width, so the side-lit
     composition stops working: the paragraph starts crossing the beams. The
     light retreats to the top-right corner instead, where the headline's
     second line leaves a genuine pocket of empty space at every width. */
  @media (max-width: 1024px) {
    .hero-light {
      width: min(80%, 640px);
      -webkit-mask-image: radial-gradient(90% 72% at 88% 26%, #000 0%, rgba(0, 0, 0, 0.55) 45%, transparent 82%);
      -webkit-mask-composite: source-over;
      mask-image: radial-gradient(90% 72% at 88% 26%, #000 0%, rgba(0, 0, 0, 0.55) 45%, transparent 82%);
      mask-composite: add;
    }
    .hero-light picture { --lit: 0.5; --lit-peak: 0.6; }
  }

  /* Phone: stop overlaying and give the photograph its own band above the
     headline. Behind type it had to be dimmed to about half strength to stay
     legible, which wasted it; in a band of its own it runs at full strength.
     The bottom edge is masked away entirely so the room dissolves down into
     the headline rather than sitting in a box. */
  @media (max-width: 720px) {
    .hero {
      min-height: 0;
      flex-direction: column;
      align-items: stretch;
      /* The band runs to the very top; the tail below the CTAs was dead space
         on a screen where vertical room is the scarce resource. */
      padding: 0 1.5rem 3rem;
    }
    .hero-light {
      position: relative;
      top: auto;
      right: auto;
      bottom: auto;
      /* Cancels the hero's side padding so the band is genuinely full-bleed. */
      width: auto;
      --band-h: clamp(220px, 33vh, 310px);
      height: var(--band-h);
      /* The band's lower third is masked to nothing, so it costs vertical space
         while showing no picture. The headline is pulled back up into that
         dissolve instead — the type emerges out of the light rather than
         starting below a gap, and the CTA moves ~80px closer to the fold. */
      margin: 0 -1.5rem calc(var(--band-h) * -0.4);
      /* Holds full strength most of the way down so the crowd silhouettes
         survive, then falls off only at the very bottom. The headline sits
         over the crowd rather than over a fade — the photograph's own darkness
         down there is what carries the type, so nothing needs dimming. */
      -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 68%, transparent 100%);
      -webkit-mask-composite: source-over;
      mask-image: linear-gradient(to bottom, #000 0%, #000 68%, transparent 100%);
      mask-composite: add;
    }
    /* Short of full strength: screen-blending this at 1.0 blows the highlights
       into a flat milky patch and throws away the beam structure that makes
       the shot worth using. */
    .hero-light picture { --lit: 0.76; --lit-peak: 0.86; }
    .hero-light img { object-position: 46% 55%; }

    /* The kicker is the one element small and quiet enough to lose against the
       photograph — --text-muted at 11px is tuned for flat --bg and drops below
       a comfortable read over lit image. Full bone, a heavier cut and a soft
       halo of the page's own black keep it legible wherever the beams fall.
       Size is deliberately untouched: 0.75rem wrapped it onto two lines at
       390px, and the legibility came from colour, weight and halo anyway. */
    .hero-kicker .mono-kicker {
      color: var(--text);
      font-weight: 700;
      text-shadow: 0 0 2px var(--bg), 0 1px 8px var(--bg);
    }
  }
  .hero-kicker {
    display: inline-flex;
    align-items: center;
    gap: 0.625rem;
    margin-bottom: 2rem;
  }
  .mono-kicker {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-muted);
  }
  .hero-headline {
    font-size: clamp(3rem, 9vw, 6.5rem);
    line-height: 0.95;
    letter-spacing: -0.045em;
    margin: 0 0 1.75rem;
    max-width: 900px;
    font-weight: 700;
  }
  .headline-tag {
    color: var(--accent);
    font-weight: 400;
    /* Bungee already runs heavy; let it carry the weight */
    letter-spacing: 0.01em;
    margin: 0 0.05em;
  }
  .hero-sub {
    font-size: clamp(1.0625rem, 1.6vw, 1.25rem);
    line-height: 1.55;
    color: var(--text-secondary);
    max-width: 620px;
    margin: 0 0 2.5rem;
  }

  /* CTAs — paired tickets */
  .hero-ctas {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.875rem;
    max-width: 800px;
    margin-bottom: 2rem;
  }
  @media (max-width: 720px) {
    .hero-ctas { grid-template-columns: 1fr; }
  }
  .cta {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 1rem;
    padding: 1.25rem 1.375rem;
    text-align: left;
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    transition: transform var(--transition-fast), background var(--transition), border-color var(--transition), color var(--transition);
    cursor: pointer;
    width: 100%;
  }
  .cta--primary {
    background: var(--accent);
    color: var(--accent-ink);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .cta--primary:hover { background: var(--accent-hover); transform: translateY(-1px); }
  .cta--primary:active { transform: translateY(0); }
  .cta--primary .cta-sub { color: rgba(11, 11, 9, 0.7); }

  .cta--ghost {
    /* Not transparent any more: this button now sits over the hero light, and
       a fully see-through panel let the beams run straight through the label.
       Mostly-opaque --bg keeps it on solid ground at any light strength. */
    background: color-mix(in srgb, var(--bg) 78%, transparent);
    color: var(--text);
    border-color: var(--border-hover);
  }
  .cta--ghost:hover {
    border-color: var(--accent);
    color: var(--accent);
    transform: translateY(-1px);
  }
  .cta--ghost:hover .cta-sub { color: var(--accent); opacity: 0.85; }

  .cta-sprite {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    color: currentColor;
  }
  .cta-body {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }
  .cta-label {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 1.0625rem;
    letter-spacing: -0.01em;
    line-height: 1.15;
  }
  .cta-sub {
    font-size: 0.8125rem;
    color: var(--text-muted);
    line-height: 1.2;
  }
  .cta-arrow { display: inline-flex; opacity: 0.9; }

  .hero-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.625rem;
    align-items: center;
    padding-top: 1.5rem;
    border-top: 1px dashed var(--border);
    color: var(--text-muted);
  }
  .hero-meta .dot { color: var(--text-dim); }

  /* hero corner stamps */
  .corner {
    position: absolute;
    font-size: 0.625rem;
    color: var(--text-dim);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    pointer-events: none;
    z-index: 1;
  }
  .corner-tl { top: 0.875rem; left: 1.5rem; }
  .corner-br { bottom: 0.875rem; right: 1.5rem; }
  @media (max-width: 720px) {
    .corner { display: none; }
  }

  /* ── Divider ────────────────────────────────────────────────────── */

  .divider {
    max-width: 1100px;
    margin: 0 auto;
    padding: 3rem 1.5rem 0;
    display: flex;
    align-items: baseline;
    gap: 1.25rem;
  }
  .divider-tag {
    color: var(--accent);
    font-size: 1.125rem;
    letter-spacing: 0.04em;
  }
  .divider-line {
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  /* ── USP blocks ─────────────────────────────────────────────────── */

  .usps {
    max-width: 1100px;
    margin: 0 auto;
    padding: 2rem 1.5rem 4rem;
  }
  .usp {
    display: grid;
    grid-template-columns: 5rem 1fr;
    gap: 1.5rem;
    padding: 2.5rem 0;
    border-bottom: 1px solid var(--border);
  }
  .usp:last-of-type { border-bottom: none; }
  .usp-num {
    font-size: 2.5rem;
    color: var(--text-dim);
    line-height: 1;
    font-weight: 500;
    letter-spacing: -0.04em;
  }
  .usp-body { max-width: 620px; }
  .usp-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    border: 1px solid var(--border-hover);
    border-radius: var(--radius-sm);
    color: var(--accent);
    margin-bottom: 1rem;
  }
  .usp h2 {
    font-size: clamp(1.625rem, 3vw, 2.25rem);
    line-height: 1.05;
    margin: 0 0 0.875rem;
    letter-spacing: -0.03em;
  }
  .usp p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 1rem;
    line-height: 1.65;
  }
  /* offset right-aligned ones to add editorial rhythm on desktop */
  @media (min-width: 880px) {
    .usp--right {
      grid-template-columns: 1fr 5rem;
    }
    .usp--right .usp-num {
      grid-column: 2;
      grid-row: 1;
      text-align: right;
    }
    .usp--right .usp-body {
      grid-column: 1;
      grid-row: 1;
      text-align: right;
    }
    .usp--right .usp-icon { margin-left: auto; }
  }

  /* ── Closing strip ──────────────────────────────────────────────── */

  .closing {
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    background:
      radial-gradient(ellipse at top right, rgba(199, 242, 58, 0.08), transparent 60%),
      var(--bg-surface);
    padding: 4rem 1.5rem;
  }
  .closing-grid {
    max-width: 1100px;
    margin: 0 auto;
    display: grid;
    /* Proportional rather than a fixed 460px: the plate has to keep shrinking
       with the column so the pair stays side by side well down into tablet
       widths. Stacking it was what made it tower over the text there. */
    grid-template-columns: minmax(0, 42%) 1fr;
    gap: 2.75rem;
    align-items: center;
  }
  @media (max-width: 640px) {
    /* Only a true phone is too narrow to hold two columns. */
    .closing-grid { grid-template-columns: 1fr; gap: 1.75rem; }
  }

  /* ── Closing plate — the decks photograph as an object ────────────────
     Capped at 460px so it renders at or below its native 1080px even on a
     2× display. Every bit of its detail is the point; upscaling it is the
     one thing that would make it look cheap. 5:4 matches the crop exactly. */

  .closing-plate {
    margin: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    background: var(--bg);
    aspect-ratio: 5 / 4;
    /* Never wider than its own native 1080px at 2x — past this it upscales
       and the fine detail that justifies the photograph starts to smear. */
    max-width: 460px;
  }
  .closing-plate picture,
  .closing-plate img {
    display: block;
    width: 100%;
    height: 100%;
  }
  .closing-plate img { object-fit: cover; }


  .closing-text h2 {
    font-size: clamp(1.5rem, 2.6vw, 2.125rem);
    margin: 1rem 0 0.875rem;
    letter-spacing: -0.025em;
    line-height: 1.1;
  }
  .closing-text p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 1rem;
    line-height: 1.6;
  }
  .closing-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.875rem 1.5rem;
    align-items: center;
    margin-top: 1.75rem;
  }
  @media (max-width: 880px) {
    .closing-actions { flex-direction: column; align-items: stretch; }
  }

  /* ── Footer ─────────────────────────────────────────────────────── */

  .footer {
    max-width: 1100px;
    margin: 0 auto;
    padding: 3rem 1.5rem 2rem;
  }
  .footer-grid {
    display: grid;
    grid-template-columns: 1fr 2fr;
    gap: 3rem;
    align-items: start;
  }
  @media (max-width: 720px) {
    .footer-grid { grid-template-columns: 1fr; gap: 2rem; }
  }
  .footer-line {
    color: var(--text-muted);
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
  }
  .footer-cols {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1.5rem;
  }
  .footer-col {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }
  .footer-col .mono-kicker { margin-bottom: 0.25rem; }
  .footer-fine {
    margin-top: 3rem;
    padding-top: 1.25rem;
    border-top: 1px solid var(--border);
    color: var(--text-dim);
    font-size: 0.625rem;
    letter-spacing: 0.16em;
    text-align: center;
  }
</style>
