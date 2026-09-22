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
  import Coins from "lucide-svelte/icons/coins";
  import HomeIcon from "lucide-svelte/icons/house";
  import Users from "lucide-svelte/icons/users-round";
  import Mail from "lucide-svelte/icons/mail";
  import { SOURCE_URL } from "./links.js";
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
      <button class="link" onclick={() => navigate("/creator")}>For organisers</button>
      {#if auth.isConnected}
        <button class="btn btn--ghost btn-sm" onclick={() => navigate("/tickets")}>My tickets</button>
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
        <span class="mono-kicker">// TICKETING AND WEBSITES FOR EVENT ORGANISERS</span>
      </div>

      <h1 class="hero-headline">
        Own your <span class="tag-display headline-tag">scene</span>.
      </h1>

      <p class="hero-sub">
        Sell tickets from your own page and build a following that stays
        yours, even if you leave. 1.5% when you sell, no monthly bill.
      </p>

      <div class="hero-ctas">
        <button class="cta cta--primary" onclick={() => navigate("/creator")}>
          <span class="cta-sprite">
            <TicketStub size={32} color="currentColor" />
          </span>
          <span class="cta-body">
            <span class="cta-label">Host an event</span>
            <span class="cta-sub">Set it up and start selling tickets</span>
          </span>
          <span class="cta-arrow"><ArrowRight size={20} strokeWidth={2.25} /></span>
        </button>

        <button class="cta cta--ghost" onclick={() => navigate("/discover")}>
          <span class="cta-sprite">
            <DoorOpen size={32} color="currentColor" />
          </span>
          <span class="cta-body">
            <span class="cta-label">Discover events</span>
            <span class="cta-sub">See what's on near you</span>
          </span>
          <span class="cta-arrow"><ArrowRight size={20} strokeWidth={2.25} /></span>
        </button>
      </div>

      <div class="hero-meta">
        <span class="mono-kicker">1.5% FEE, NEVER MORE</span>
        <span class="dot">·</span>
        <span class="mono-kicker">NO MONTHLY BILL</span>
        <span class="dot">·</span>
        <span class="mono-kicker">OPEN SOURCE</span>
      </div>
    </div>

    <!-- corner stamps -->
    <div class="corner corner-tl mono">EST. 2025 · PRE-LAUNCH</div>
    <div class="corner corner-br mono">v0 // NO LOCK-IN</div>
  </section>

  <!-- ── Launch offer ────────────────────────────────────────────────
       An offer with a shelf life, not a product feature, so it sits in its
       own band under the hero rather than becoming another numbered reason. -->
  <section class="offer">
    <div class="offer-inner">
      <span class="mono-kicker offer-kicker">// LAUNCH OFFER</span>
      <h2>Bring someone over. Take 40% of our fee.<span class="star">*</span></h2>
      <p>
        Share your link. When someone starts selling through it, 40% of the
        1.5% we take comes back to you.
      </p>
      <button class="btn btn--primary" onclick={() => navigate("/profile")}>
        Get your link
        <ArrowRight size={18} strokeWidth={2.5} />
      </button>
      <p class="offer-fine">
        * Launch rate, and it can change - we'll tell you before it does. Your
        share builds up from each sale and is paid monthly in stablecoin once
        the event has taken place. We're aiming for the first payout on or
        before 31 December 2026.
        <button class="link-inline" onclick={() => navigate("/legal/terms")}>Full terms</button>
      </p>
    </div>
  </section>

  <!-- ── Why organisers switch — the business case, in their words ───── -->
  <div class="section-head">
    <span class="section-tag tag-display">Why switch</span>
    <span class="section-line"></span>
    <span class="mono-kicker">// WHAT YOU GET</span>
  </div>

  <section class="reasons">
    <!-- 01 leads because nobody else can offer it. Deliberately says nothing
         about where a follow is stored: the benefit is that it outlives us, and
         an organiser does not need the mechanism to understand that. -->
    <article class="reason">
      <div class="reason-top">
        <span class="reason-num mono">01</span>
        <span class="reason-icon"><Users size={20} strokeWidth={2.25} /></span>
      </div>
      <h3>Your followers stay yours.</h3>
      <p>
        On other platforms your followers belong to the platform. It sends the
        alerts, on its schedule, and the list never leaves with you.
      </p>
      <p>
        Here, a follow belongs to the person who made it. We can't hold it
        hostage, and if WoCo disappeared tomorrow your following would still be
        there.
      </p>
    </article>

    <!-- The page and the web address are separate sentences on purpose: the
         page carries no WoCo branding at all, but the free address has our
         name behind theirs. Claiming otherwise buys a bad first five minutes. -->
    <article class="reason">
      <div class="reason-top">
        <span class="reason-num mono">02</span>
        <span class="reason-icon"><HomeIcon size={20} strokeWidth={2.25} /></span>
      </div>
      <h3>Your name on it, not ours.</h3>
      <p>
        Your artwork, your colours, your name at the top. No WoCo logo in the
        corner, no eleven other events down the side.
      </p>
      <p>
        Point your own domain at it, or start on a free web address with your
        name at the front. Need a full website? Build that here too, with no
        extra subscription.
      </p>
    </article>

    <!-- 30p on a £20 ticket is exact: checkout-fees.ts charges the 1.5% on the
         ticket subtotal, not the total. -->
    <article class="reason">
      <div class="reason-top">
        <span class="reason-num mono">03</span>
        <span class="reason-icon"><Coins size={20} strokeWidth={2.25} /></span>
      </div>
      <h3>Charge a booking fee. Keep it.</h3>
      <p>
        Most platforms add a booking fee and pocket it. Set yours here and it's
        yours. We take 1.5% of the ticket price, nothing else.
      </p>
      <p>
        A £20 ticket with a 10% booking fee: the buyer pays £22, 30p comes to
        us, and the rest is yours once the card fee's paid. Or charge nothing at
        all. Your call, event by event.
      </p>
    </article>

    <!-- The follow-time opt-in line was cut: #416 (the opt-in itself) is still
         open, and this page may not promise what the product does not do. -->
    <article class="reason">
      <div class="reason-top">
        <span class="reason-num mono">04</span>
        <span class="reason-icon"><Mail size={20} strokeWidth={2.25} /></span>
      </div>
      <h3>Bring your mailing list.</h3>
      <p>
        Import from Eventbrite, Ticket Tailor or a spreadsheet and you've moved.
        Unsubscribes, consent records and the one-click opt-out the rules
        require are built in and run on every send.
      </p>
      <p>
        Then email your people from here. Emailing your own ticket buyers is
        free, and always will be.
      </p>
      <p>
        Fans can follow you too, and you'll see your following grow on your
        events.
      </p>
    </article>
  </section>

  <!-- ── Built differently — what the architecture buys an organiser ────
       Three claims, each checked against the code: verify.ts (offline check
       against pre-downloaded slot owners), DATA_INVENTORY.md §4 (the server
       seals and has no code path to open). Nothing here may say more. -->
  <section class="built">
    <div class="built-inner">
      <div class="built-head">
        <span class="mono-kicker">// HOW IT'S BUILT</span>
        <h2>Built differently, on purpose.</h2>
        <p>
          The same things other platforms do, built so they don't depend on
          trusting us.
        </p>
      </div>

      <div class="built-grid">
        <article class="built-item">
          <span class="built-label mono">Signed</span>
          <h3>Scans with no signal.</h3>
          <p>
            Every ticket is signed when it's issued and recorded onchain. The
            door phone checks that signature itself, against a list it
            downloaded before doors - so a basement with no bars scans as fast
            as anywhere.
          </p>
          <p>Anyone can check a WoCo ticket is real, without asking us.</p>
          <span class="built-spec mono">Signed at issue · checked offline</span>
        </article>

        <article class="built-item">
          <span class="built-label mono">Sealed</span>
          <h3>Your buyers' details, locked to you.</h3>
          <p>
            The answers people give on your order form are encrypted to a key
            only you hold. We store them. We can't read them.
          </p>
          <p>Your mailing list is stored the same way.</p>
          <span class="built-spec mono">X25519 + AES-256-GCM</span>
        </article>

        <article class="built-item">
          <span class="built-label mono">Kept</span>
          <h3>A ticket they keep.</h3>
          <p>
            The ticket doesn't die at the door. It stays on their phone as proof
            they were there, and you can build on that: open the presale to
            everyone who came last time, or put a fiver off the third visit.
          </p>
          <p>No email address needed. The ticket is the proof.</p>
          <span class="built-spec mono">One ticket · one holder</span>
        </article>
      </div>

      <button class="built-more" onclick={() => navigate("/about")}>
        How WoCo works, in full
        <ArrowRight size={16} strokeWidth={2.5} />
      </button>
    </div>
  </section>

  <!-- ── The declaration ─────────────────────────────────────────────
       The page's centrepiece. Every line is a promise about our own conduct
       that we can keep unilaterally. Nothing here says what anyone OWNS of
       WoCo (shares, tokens, a stake) - "public good" is an aim we state, never
       a legal form we claim. The fee line is a ceiling that only ratchets
       down; if the fee ever needs to rise, this block is wrong, not the fee. -->
  <section class="declaration">
    <div class="declaration-inner">
      <span class="mono-kicker declaration-kicker">// THE WOCO DECLARATION</span>

      <div class="declaration-top">
        <h2 class="fee-statement">
          <span class="fee-number">1.5%</span>
          <span class="fee-line">It only goes down.</span>
        </h2>
        <div class="declaration-lede">
          <p class="lede-strong">
            Our fee is 1.5% of the ticket price, and it will never go up. When
            we can bring it down, we will - and every time we do, the lower rate
            becomes the new ceiling.
          </p>
          <p>
            Most platforms grow by taking more: bigger fees, paid placement,
            your crowd's data. We're building the opposite - ticketing that
            works like public infrastructure, for the people who put events on
            and the people who go to them.
          </p>
        </div>
      </div>

      <ol class="pledges">
        <li>
          <span class="pledge-num mono">01</span>
          <div>
            <strong>Yours to take with you.</strong>
            Your following, your pages and your mailing list go wherever you
            go. Nothing here is designed to make leaving hard.
          </div>
        </li>
        <li>
          <span class="pledge-num mono">02</span>
          <div>
            <strong>Nothing for sale.</strong>
            No ads and no promoted events. We don't sell what we know about the
            people who come to your events.
          </div>
        </li>
        <li>
          <span class="pledge-num mono">03</span>
          <div>
            <strong>Open source.</strong>
            The code is public, so anyone can read how WoCo works - and check
            a ticket is real without asking us.
          </div>
        </li>
        <li>
          <span class="pledge-num mono">04</span>
          <div>
            <strong>Built to outlast us.</strong>
            Your events, pages, tickets and followers live on open networks,
            not in a database we own.
          </div>
        </li>
        <li class="pledge-wide">
          <span class="pledge-num mono">05</span>
          <div>
            <strong>A public good, not an exit.</strong>
            We're working towards WoCo being infrastructure the scene can rely
            on in ten years' time, answerable to the people who use it. We're
            building it to last, not to be sold.
          </div>
        </li>
      </ol>
    </div>
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
        <h2>Put your next event on sale.</h2>
        <p>
          Free to set up. 1.5% when you sell, and never more. The following you
          build is yours to keep.
        </p>
        <div class="closing-actions">
          <button class="btn btn--primary btn--lg" onclick={() => navigate("/creator")}>
            Set up an event
            <ArrowRight size={18} strokeWidth={2.5} />
          </button>
          <button class="link link-quiet" onclick={() => navigate("/discover")}>
            or see what's on →
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
        <p class="footer-line">Ticketing and websites for event organisers.</p>
      </div>
      <div class="footer-cols">
        <div class="footer-col">
          <span class="mono-kicker">Platform</span>
          <button class="link" onclick={() => navigate("/discover")}>Discover events</button>
          <button class="link" onclick={() => navigate("/creator")}>Host an event</button>
          <button class="link" onclick={() => navigate("/tickets")}>My tickets</button>
        </div>
        <div class="footer-col">
          <span class="mono-kicker">WoCo</span>
          <button class="link" onclick={() => navigate("/about")}>How it works</button>
          <a class="link" href={SOURCE_URL} target="_blank" rel="noopener">Source code</a>
        </div>
        <div class="footer-col">
          <span class="mono-kicker">Legal</span>
          <button class="link" onclick={() => navigate("/legal/terms")}>Terms</button>
          <button class="link" onclick={() => navigate("/legal/organiser-terms")}>Organiser terms</button>
          <button class="link" onclick={() => navigate("/legal/privacy")}>Privacy</button>
          <button class="link" onclick={() => navigate("/legal/cookies")}>Cookies</button>
        </div>
      </div>
    </div>
    <div class="footer-fine mono">© 2026 · YOUR FOLLOWING IS YOURS TO KEEP</div>
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
    text-decoration: none;
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


  /* ── Section head ───────────────────────────────────────────────── */

  /* The bands below (offer, built, declaration) pad OUTSIDE a 1100px column;
     these pad inside it. Adding the padding back puts every left edge on the
     page on one line. */
  .section-head {
    max-width: calc(1100px + 3rem);
    margin: 0 auto;
    padding: 3.5rem 1.5rem 0;
    display: flex;
    align-items: baseline;
    gap: 1.25rem;
  }
  .section-tag {
    color: var(--accent);
    font-size: 1.125rem;
    letter-spacing: 0.04em;
  }
  .section-line {
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  /* ── Reasons — a ruled 2×2 on desktop, a plain stack on a phone ──────
     The old alternating left/right rhythm right-aligned whole paragraphs and
     left half the width empty; a grid reads left to right like everything
     else on the page and fits all four above the fold on a laptop. */

  .reasons {
    max-width: calc(1100px + 3rem);
    margin: 0 auto;
    padding: 2rem 1.5rem 4.5rem;
    display: grid;
    grid-template-columns: 1fr;
  }
  .reason {
    padding: 2rem 0;
    border-bottom: 1px solid var(--border);
  }
  .reason:last-child { border-bottom: none; }

  @media (min-width: 880px) {
    .reasons {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .reason {
      padding: 2.5rem 2.75rem 2.75rem 0;
    }
    /* Ruled like a spec sheet: one vertical hairline between the columns,
       one horizontal between the rows, none on the outside edges. */
    .reason:nth-child(odd) { border-right: 1px solid var(--border); }
    .reason:nth-child(even) { padding-left: 2.75rem; padding-right: 0; }
    .reason:nth-last-child(-n + 2) { border-bottom: none; }
  }

  .reason-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.25rem;
  }
  .reason-num {
    font-size: 0.8125rem;
    color: var(--text-dim);
    letter-spacing: 0.08em;
  }
  .reason-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    border: 1px solid var(--border-hover);
    border-radius: var(--radius-sm);
    color: var(--accent);
  }
  .reason h3 {
    font-size: clamp(1.5rem, 2.4vw, 1.875rem);
    line-height: 1.1;
    letter-spacing: -0.03em;
    margin: 0 0 0.875rem;
  }
  .reason p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 1rem;
    line-height: 1.65;
    max-width: 52ch;
  }
  .reason p + p { margin-top: 0.75rem; }

  /* ── Built differently ──────────────────────────────────────────── */

  .built {
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
    padding: 4rem 1.5rem;
  }
  .built-inner {
    max-width: 1100px;
    margin: 0 auto;
  }
  .built-head {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 2.5rem;
  }
  .built-head h2 {
    font-size: clamp(1.75rem, 3.4vw, 2.625rem);
    line-height: 1.05;
    letter-spacing: -0.035em;
    margin: 0;
  }
  .built-head p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 1.0625rem;
    line-height: 1.55;
    max-width: 48ch;
  }

  .built-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1rem;
  }
  @media (min-width: 960px) {
    .built-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }

  .built-item {
    display: flex;
    flex-direction: column;
    padding: 1.75rem 1.5rem 1.5rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-top: 2px solid var(--accent);
    border-radius: var(--radius-sm);
  }
  .built-label {
    font-size: 0.6875rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--accent);
    margin-bottom: 1rem;
  }
  .built-item h3 {
    font-size: clamp(1.375rem, 2vw, 1.625rem);
    line-height: 1.1;
    letter-spacing: -0.03em;
    margin: 0 0 0.875rem;
  }
  .built-item p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.9375rem;
    line-height: 1.6;
  }
  .built-item p + p { margin-top: 0.625rem; }
  .built-item p:last-of-type { margin-bottom: 1.25rem; }
  /* Pinned to the bottom so the three spec lines sit on one baseline however
     long each paragraph runs. */
  .built-spec {
    margin-top: auto;
    padding-top: 0.875rem;
    border-top: 1px dashed var(--border);
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-muted);
  }

  .built-more {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 2rem;
    padding: 0.25rem 0;
    font-family: var(--font-body);
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
    background: none;
    border: none;
    border-bottom: 1px solid var(--accent);
    cursor: pointer;
    transition: color var(--transition);
  }
  .built-more:hover { color: var(--accent); }

  /* ── The declaration ────────────────────────────────────────────── */

  .declaration {
    position: relative;
    padding: 5rem 1.5rem 5.5rem;
    background:
      radial-gradient(ellipse 60% 70% at 0% 0%, var(--accent-subtle), transparent 70%),
      var(--bg);
    overflow: hidden;
  }
  .declaration-inner {
    max-width: 1100px;
    margin: 0 auto;
  }
  .declaration-kicker { color: var(--accent); }

  .declaration-top {
    display: grid;
    grid-template-columns: 1fr;
    gap: 2rem;
    margin: 1.75rem 0 3.5rem;
  }
  @media (min-width: 960px) {
    .declaration-top {
      grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
      gap: 3.5rem;
      align-items: end;
    }
  }

  .fee-statement {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .fee-number {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: clamp(5.5rem, 17vw, 11rem);
    line-height: 0.82;
    letter-spacing: -0.06em;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }
  .fee-line {
    font-size: clamp(1.75rem, 4vw, 2.75rem);
    line-height: 1.05;
    letter-spacing: -0.035em;
    color: var(--text);
  }

  .declaration-lede p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 1rem;
    line-height: 1.65;
    max-width: 54ch;
  }
  .declaration-lede p + p { margin-top: 1rem; }
  .declaration-lede .lede-strong {
    color: var(--text);
    font-size: clamp(1.0625rem, 1.5vw, 1.1875rem);
    line-height: 1.55;
  }

  .pledges {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: 1fr;
    border-top: 1px solid var(--border);
  }
  @media (min-width: 880px) {
    .pledges { grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 2.75rem; }
    .pledges .pledge-wide { grid-column: 1 / -1; }
    .pledges .pledge-wide > div { max-width: 72ch; }
  }
  .pledges li {
    display: grid;
    grid-template-columns: 2.25rem 1fr;
    gap: 0.75rem;
    padding: 1.375rem 0;
    border-bottom: 1px solid var(--border);
    color: var(--text-secondary);
    font-size: 1rem;
    line-height: 1.6;
  }
  .pledges strong {
    color: var(--text);
    font-weight: 700;
    margin-right: 0.25rem;
  }
  .pledge-num {
    font-size: 0.75rem;
    color: var(--accent);
    padding-top: 0.25rem;
    letter-spacing: 0.06em;
  }

  /* ── Launch offer band ──────────────────────────────────────────────
     Tinted rather than plain so it reads as an offer and not another reason,
     and so the page gets a change of ground between the hero and the list. */

  .offer {
    border-bottom: 1px solid var(--border);
    background:
      linear-gradient(180deg, var(--accent-subtle), transparent 70%),
      var(--bg);
    padding: 2.75rem 1.5rem;
  }
  .offer-inner {
    max-width: 1100px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.875rem;
  }
  .offer-kicker { color: var(--accent); }
  .offer h2 {
    font-size: clamp(1.5rem, 3.2vw, 2.25rem);
    letter-spacing: -0.03em;
    line-height: 1.05;
    margin: 0;
    max-width: 20ch;
  }
  .offer .star { color: var(--accent); }
  .offer > .offer-inner > p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 1rem;
    line-height: 1.6;
    max-width: 56ch;
  }
  .offer-inner p.offer-fine {
    font-size: 0.8125rem;
    line-height: 1.5;
    color: var(--text-muted);
    max-width: 62ch;
  }
  .link-inline {
    font-family: var(--font-body);
    font-size: inherit;
    color: var(--text-secondary);
    background: none;
    border: none;
    padding: 0;
    text-decoration: underline;
    cursor: pointer;
  }
  .link-inline:hover { color: var(--accent); }

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
    max-width: calc(1100px + 3rem);
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
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1.5rem;
  }
  @media (max-width: 480px) {
    .footer-cols { grid-template-columns: repeat(2, minmax(0, 1fr)); row-gap: 2rem; }
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
