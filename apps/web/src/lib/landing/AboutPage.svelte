<!--
  AboutPage — "How WoCo works", the technical companion to the landing page.
  Linked from the landing footer and the "Built differently" band.

  Every claim here is checked against the code or the design docs it cites
  (docs/ARCHITECTURE.md, docs/IDENTITY_AND_KEYS.md, docs/legal/DATA_INVENTORY.md
  §4, apps/web/src/lib/scanner/verify.ts). The rule is the same as for legal
  copy: confident register, never more than the code does. If a mechanism
  changes, this page changes with it.
-->
<script lang="ts">
  import { navigate } from "../router/router.svelte.js";
  import WocoWordmark from "../components/brand/WocoWordmark.svelte";
  import ArrowRight from "lucide-svelte/icons/arrow-right";

  const SECTIONS = [
    { id: "short", label: "The short version" },
    { id: "account", label: "Your account" },
    { id: "tickets", label: "Tickets" },
    { id: "privacy", label: "Privacy" },
    { id: "storage", label: "Storage" },
    { id: "followers", label: "Followers" },
    { id: "server", label: "Our server" },
    { id: "payments", label: "Payments" },
    { id: "code", label: "The code" },
  ] as const;

  // Set and restored by hand: a <svelte:head> title outlives the page, so the
  // landing page would keep this title after navigating back to it.
  $effect(() => {
    // The router keeps the scroll position across routes; this page is
    // reached from footers, so without this it opens at its own bottom.
    window.scrollTo(0, 0);
    const previous = document.title;
    document.title = "How WoCo works";
    return () => {
      document.title = previous;
    };
  });

  // Hash routing owns the fragment, so an in-page anchor would navigate away.
  function jump(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
</script>

<div class="about">
  <header class="top">
    <button class="brand" onclick={() => navigate("/")} aria-label="WoCo home">
      <WocoWordmark height={22} variant="default" />
    </button>
    <nav class="top-nav">
      <button class="link" onclick={() => navigate("/discover")}>Discover</button>
      <button class="link" onclick={() => navigate("/creator")}>For organisers</button>
    </nav>
  </header>

  <section class="intro">
    <span class="mono-kicker">// UNDER THE HOOD</span>
    <h1>How WoCo works</h1>
    <p class="intro-lede">
      WoCo is ticketing and websites for event organisers. Underneath, it runs
      on open networks rather than a private database, so the parts that matter
      can be checked by anyone instead of taken on trust. Events are where we
      begin: none of what follows is specific to them.
    </p>
    <p class="intro-note">
      This is the technical version, for anyone who wants to check our working.
    </p>
  </section>

  <div class="layout">
    <nav class="toc" aria-label="On this page">
      <span class="mono-kicker">On this page</span>
      {#each SECTIONS as s (s.id)}
        <button class="toc-link" onclick={() => jump(s.id)}>{s.label}</button>
      {/each}
    </nav>

    <div class="content">
      <!-- ── The short version ── -->
      <section id="short" class="block">
        <span class="block-label mono">01 · Overview</span>
        <h2>The short version</h2>
        <div class="pillars">
          <div class="pillar">
            <span class="pillar-tag mono">Browser</span>
            <h3>You sign what you write.</h3>
            <p>
              Your browser holds your keys and signs your events, pages, profile
              and follows. Our servers hold no key that can sign as you.
            </p>
          </div>
          <div class="pillar">
            <span class="pillar-tag mono">Swarm</span>
            <h3>Storage is an open network.</h3>
            <p>
              Signed content lives on Swarm, a decentralised storage network.
              Anyone can read it and check the signature. Only the owner can
              write to it.
            </p>
          </div>
          <div class="pillar">
            <span class="pillar-tag mono">Chain</span>
            <h3>Tickets settle onchain.</h3>
            <p>
              Who holds a ticket needs one agreed answer, so it's recorded on a
              public blockchain.
            </p>
          </div>
          <div class="pillar">
            <span class="pillar-tag mono">Server</span>
            <h3>Our server does the rest.</h3>
            <p>
              Card payments, email, paying for storage, and onchain transactions
              for people who don't have a wallet. It can't forge anything you've
              signed.
            </p>
          </div>
        </div>
      </section>

      <!-- ── Account ── -->
      <section id="account" class="block">
        <span class="block-label mono">02 · Identity</span>
        <h2>Your account</h2>
        <p>
          Sign in with a passkey, your email or Google account, or a crypto
          wallet. Signing in doesn't sign anything. The first time you do
          something that needs it, your account approves two things: a session
          key that signs each request you make to our API and expires after 30
          days, and one fixed signature that your browser turns into your
          long-term keys.
        </p>
        <ul class="keys">
          <li><span class="mono">Content key</span><span>Owns everything you publish to Swarm.</span></li>
          <li><span class="mono">Issuing key</span><span>Signs the tickets an organiser issues.</span></li>
          <li><span class="mono">Encryption key</span><span>Opens the order details your buyers send you.</span></li>
        </ul>
        <p>
          Because that signature is the same every time, the same account on
          another device gets the same keys. Nothing needs copying across, and
          our servers never hold them. Passkey and email accounts are smart
          accounts on Arbitrum One.
        </p>
      </section>

      <!-- ── Tickets ── -->
      <section id="tickets" class="block">
        <span class="block-label mono">03 · Ticketing</span>
        <h2>Tickets</h2>
        <p>
          When an organiser publishes a ticket type, their issuing key signs one
          manifest committing to every ticket in it, and the ticket type is
          registered onchain.
        </p>
        <p>
          When someone buys by card, we create a single-use key for each ticket,
          record it onchain as that ticket's holder, have it sign the ticket once,
          and throw the key away. That signature is the QR code. The buyer never
          needs a wallet.
        </p>
        <p>
          At the door, the scanner works out who signed the QR and compares it
          with the holder onchain. It downloads the holders before doors open,
          so the check happens on the phone, with or without signal.
        </p>
      </section>

      <!-- ── Privacy ── (DATA_INVENTORY.md §4: the server imports seal only) -->
      <section id="privacy" class="block">
        <span class="block-label mono">04 · Privacy</span>
        <h2>Privacy</h2>
        <p>
          Answers to an organiser's order form are encrypted to that organiser's
          key, using X25519 key agreement and AES-256-GCM. Our server can seal
          data to an organiser, but it has no way to open it: only the
          organiser's browser can. Organisers' mailing lists are stored the same
          way.
        </p>
        <p>
          Where we need to recognise an email address, for unsubscribes and
          consent records, we keep a keyed hash of it (HMAC-SHA256) rather than
          the address itself.
        </p>
        <p>
          Two things sit outside that: we see a buyer's email address when we
          send their ticket, because we have to, and Stripe holds payment
          details under its own policies.
        </p>
        <button class="doc-link" onclick={() => navigate("/legal/privacy")}>
          Privacy policy <ArrowRight size={14} strokeWidth={2.5} />
        </button>
      </section>

      <!-- ── Storage ── -->
      <section id="storage" class="block">
        <span class="block-label mono">05 · Storage</span>
        <h2>Storage</h2>
        <p>
          Everything you publish (events, pages, your profile, follows) is a
          signed chunk on Swarm, at an address anyone can work out from who
          wrote it and what it's about. Updating something writes a new
          version, and each version carries its author's signature.
        </p>
        <p>
          Our server checks the signature and pays for the storage before it
          uploads anything, but it can't write as you. Websites built with WoCo
          are published to Swarm as standalone sites, and can carry a name under
          woco.eth.
        </p>
      </section>

      <!-- ── Followers ── -->
      <section id="followers" class="block">
        <span class="block-label mono">06 · Social</span>
        <h2>Followers</h2>
        <p>
          A follow is a statement signed by the fan's own key and written to the
          fan's own feed. Nobody else can write to it, including us. Unfollowing
          is a new statement, not a deletion.
        </p>
        <p>
          Follower counts are worked out by reading those feeds, so anyone can
          count them again and get the same answer.
        </p>
      </section>

      <!-- ── Server ── (ARCHITECTURE.md §1.1: "cannot author, but can misdirect") -->
      <section id="server" class="block">
        <span class="block-label mono">07 · Trust</span>
        <h2>What our server does</h2>
        <p>
          It holds the secrets a browser can't: the Stripe keys, the email
          service, and the wallet that pays for onchain transactions. It checks
          signatures, pays for storage, and sends onchain transactions for
          people who don't have a wallet.
        </p>
        <p>
          It can't forge anything you've signed. It does help apps find content,
          and most event pages load through it today, which is exactly why
          everything that matters is signed: an app can check what it's shown
          rather than trust where it came from.
        </p>
      </section>

      <!-- ── Payments ── (ORGANISER_TERMS: not an escrow, released after the event) -->
      <section id="payments" class="block">
        <span class="block-label mono">08 · Money</span>
        <h2>Payments</h2>
        <p>
          Card payments run through Stripe Connect, straight into the
          organiser's own Stripe account. We don't hold the money, and we
          normally release each event's takings after the event. Our fee is 1.5%
          of the ticket price, and it only goes down: the organiser terms cap it
          at 1.5% and stop any update to those terms raising the cap.
        </p>
        <!-- DELETE AT LAUNCH, alongside PreLaunchBanner: both name the test
             rails (Stripe test mode, Arbitrum Sepolia). -->
        <p class="note">
          WoCo is pre-launch. Until launch, card payments run in Stripe's test
          mode and tickets are recorded on Arbitrum Sepolia, a test network.
        </p>
        <button class="doc-link" onclick={() => navigate("/legal/organiser-terms")}>
          Organiser terms <ArrowRight size={14} strokeWidth={2.5} />
        </button>
      </section>

      <!-- ── Code ── -->
      <section id="code" class="block">
        <span class="block-label mono">09 · Open source</span>
        <h2>The code</h2>
        <p>
          WoCo is MIT-licensed and the code is public. What that buys is the
          ability to audit how any of this works. It is not what lets anyone
          check a ticket: that works because the ticket carries a signature and
          the chain carries its holder, and both are public.
        </p>
      </section>
    </div>
  </div>

  <footer class="foot">
    <button class="link" onclick={() => navigate("/")}>← Back to WoCo</button>
    <span class="mono foot-fine">If this page and the code disagree, the code wins. Tell us.</span>
  </footer>
</div>

<style>
  .about {
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
  }

  /* ── Top bar — mirrors the landing page's ── */
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
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }
  .top-nav { display: flex; align-items: center; gap: 1.5rem; }
  .link {
    font-family: var(--font-body);
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text-secondary);
    background: none;
    border: none;
    padding: 0.25rem 0;
    cursor: pointer;
    border-bottom: 1px solid transparent;
    transition: color var(--transition);
  }
  .link:hover { color: var(--accent); border-bottom-color: var(--accent); }

  .mono-kicker {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-muted);
  }

  /* ── Intro ── */
  .intro {
    max-width: 1100px;
    margin: 0 auto;
    padding: 3.5rem 1.5rem 3rem;
    border-bottom: 1px solid var(--border);
  }
  .intro .mono-kicker { color: var(--accent); }
  .intro h1 {
    font-size: clamp(2.5rem, 7vw, 4.75rem);
    line-height: 0.95;
    letter-spacing: -0.045em;
    margin: 1.25rem 0 1.5rem;
  }
  .intro-lede {
    font-size: clamp(1.0625rem, 1.6vw, 1.25rem);
    line-height: 1.55;
    color: var(--text);
    max-width: 58ch;
    margin: 0 0 1rem;
  }
  .intro-note {
    font-size: 0.9375rem;
    line-height: 1.6;
    color: var(--text-muted);
    max-width: 58ch;
    margin: 0;
  }

  /* ── Layout: sticky contents beside the long read on desktop ── */
  .layout {
    max-width: 1100px;
    margin: 0 auto;
    padding: 0 1.5rem;
    display: grid;
    grid-template-columns: 1fr;
  }
  .toc { display: none; }

  @media (min-width: 960px) {
    .layout {
      grid-template-columns: 200px minmax(0, 1fr);
      gap: 4rem;
    }
    .toc {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 0.5rem;
      position: sticky;
      top: 2rem;
      align-self: start;
      padding-top: 3rem;
    }
    .toc .mono-kicker { margin-bottom: 0.5rem; }
  }
  .toc-link {
    font-family: var(--font-body);
    font-size: 0.875rem;
    color: var(--text-muted);
    background: none;
    border: none;
    padding: 0.125rem 0;
    text-align: left;
    cursor: pointer;
    transition: color var(--transition);
  }
  .toc-link:hover { color: var(--accent); }

  .content { min-width: 0; }

  /* ── Blocks ── */
  .block {
    padding: 3rem 0;
    border-bottom: 1px solid var(--border);
    scroll-margin-top: 1rem;
  }
  .block:last-child { border-bottom: none; }
  .block-label {
    display: block;
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--accent);
    margin-bottom: 0.75rem;
  }
  .block h2 {
    font-size: clamp(1.625rem, 3vw, 2.25rem);
    line-height: 1.05;
    letter-spacing: -0.035em;
    margin: 0 0 1.25rem;
  }
  .block > p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 1rem;
    line-height: 1.7;
    max-width: 64ch;
  }
  .block > p + p { margin-top: 1rem; }
  .block > p.note {
    margin-top: 1.25rem;
    padding: 0.75rem 1rem;
    border-left: 2px solid var(--accent);
    background: var(--accent-subtle);
    color: var(--text-secondary);
    font-size: 0.9375rem;
  }

  /* ── The short version: four ruled cells ── */
  .pillars {
    display: grid;
    grid-template-columns: 1fr;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  @media (min-width: 720px) {
    .pillars { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .pillar:nth-child(odd) { border-right: 1px solid var(--border); }
    .pillar:nth-last-child(-n + 2) { border-bottom: none; }
  }
  .pillar {
    padding: 1.5rem;
    border-bottom: 1px solid var(--border);
  }
  .pillar:last-child { border-bottom: none; }
  .pillar-tag {
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--text-muted);
  }
  .pillar h3 {
    font-size: 1.1875rem;
    letter-spacing: -0.02em;
    margin: 0.625rem 0 0.5rem;
  }
  .pillar p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.9375rem;
    line-height: 1.6;
  }

  .keys {
    list-style: none;
    margin: 1.25rem 0;
    padding: 0;
    border-top: 1px solid var(--border);
    max-width: 64ch;
  }
  .keys li {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.25rem;
    padding: 0.75rem 0;
    border-bottom: 1px solid var(--border);
    color: var(--text-secondary);
    font-size: 0.9375rem;
    line-height: 1.5;
  }
  @media (min-width: 560px) {
    .keys li { grid-template-columns: 9.5rem 1fr; gap: 1rem; align-items: baseline; }
  }
  .keys .mono {
    color: var(--text);
    font-size: 0.8125rem;
  }

  .doc-link {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin-top: 1.5rem;
    padding: 0.125rem 0;
    font-family: var(--font-mono);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text);
    text-decoration: none;
    background: none;
    border: none;
    border-bottom: 1px solid var(--accent);
    cursor: pointer;
    transition: color var(--transition);
  }
  .doc-link:hover { color: var(--accent); }

  .foot {
    max-width: 1100px;
    margin: 0 auto;
    padding: 2rem 1.5rem 3rem;
    border-top: 1px solid var(--border);
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 1rem;
    align-items: center;
  }
  .foot-fine {
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-dim);
  }
</style>
