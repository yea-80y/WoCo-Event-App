<script lang="ts">
  import type { EventDirectoryEntry } from "@woco/shared";
  import { listEvents } from "../../api/events.js";
  import { navigate } from "../../router/router.svelte.js";
  import EventCard from "../events/EventCard.svelte";
  import { onMount } from "svelte";

  let events = $state<EventDirectoryEntry[]>([]);
  let loading = $state(true);

  onMount(async () => {
    try {
      events = await listEvents();
    } catch {
      // Silent — events section just won't show
    } finally {
      loading = false;
    }
  });
</script>

<!-- Hero -->
<section class="hero">
  <img src="./logo.png" alt="WoCo" class="hero-logo" />
  <h1>Event ticketing on the decentralized web</h1>
  <p class="hero-sub">
    Create events, issue cryptographically signed tickets, and manage attendees
    — all stored on the <a href="https://www.ethswarm.org" target="_blank" rel="noopener">Swarm Network</a>,
    not a corporate server.
  </p>
  <div class="hero-actions">
    <button class="btn-primary" onclick={() => navigate("/create")}>
      Create an event
    </button>
    <a class="btn-outline" href="#how-it-works">How it works</a>
  </div>
</section>

<!-- How it works -->
<section class="how-it-works" id="how-it-works">
  <h2>How it works</h2>
  <div class="steps">
    <div class="step">
      <span class="step-num">1</span>
      <h3>Create your event</h3>
      <p>Add your event details, ticket types, and quantities. Optionally collect attendee info with encrypted order forms.</p>
    </div>
    <div class="step">
      <span class="step-num">2</span>
      <h3>Tickets are signed</h3>
      <p>Each ticket is cryptographically signed with your unique identity key. Every ticket is verifiably authentic and tamper-proof.</p>
    </div>
    <div class="step">
      <span class="step-num">3</span>
      <h3>Attendees claim</h3>
      <p>Share your event link. Attendees claim tickets with a wallet or email — no app download, no account creation required for email claims.</p>
    </div>
    <div class="step">
      <span class="step-num">4</span>
      <h3>Embed on your website</h3>
      <p>Generate an embed code from any event page and paste it into your website. Attendees claim tickets without leaving your site.</p>
    </div>
    <div class="step">
      <span class="step-num">5</span>
      <h3>Manage from your dashboard</h3>
      <p>View claims, decrypt attendee info locally in your browser, export CSVs, and forward data to your email service via webhooks.</p>
    </div>
  </div>
</section>

<!-- Features -->
<section class="features">
  <h2>What makes this different</h2>
  <div class="feature-grid">
    <div class="feature">
      <div class="feature-icon">&#128274;</div>
      <h3>End-to-end encrypted</h3>
      <p>Attendee info is encrypted before it leaves their browser. Only you can decrypt it — not us, not the storage network.</p>
    </div>
    <div class="feature">
      <div class="feature-icon">&#128396;</div>
      <h3>Cryptographically signed</h3>
      <p>Every ticket carries a digital signature from the creator's identity key. Authenticity is mathematically provable, not based on trust.</p>
    </div>
    <div class="feature">
      <div class="feature-icon">&#127760;</div>
      <h3>Decentralized storage</h3>
      <p>Events and tickets live on the Swarm Network — a peer-to-peer storage layer. No single point of failure, no vendor lock-in.</p>
    </div>
    <div class="feature">
      <div class="feature-icon">&#9889;</div>
      <h3>No sign-up needed</h3>
      <p>Attendees claim with a wallet connection or just an email. No accounts, no passwords, no app to install.</p>
    </div>
  </div>
</section>

<!-- Events -->
<section class="events-section">
  <h2>Events</h2>
  {#if loading}
    <p class="status">Loading events...</p>
  {:else if events.length === 0}
    <div class="empty">
      <p>No events yet</p>
      <p class="sub">Be the first to create one.</p>
    </div>
  {:else}
    <div class="event-grid">
      {#each events as event}
        <EventCard {event} onclick={() => navigate(`/event/${event.eventId}`)} />
      {/each}
    </div>
  {/if}
</section>

<!-- Coming soon -->
<section class="coming-soon">
  <h2>Coming soon</h2>
  <div class="roadmap-grid">
    <div class="roadmap-item">
      <span class="roadmap-tag">Identity</span>
      <h3>Zupass integration</h3>
      <p>Sign in with your Zupass identity — no wallet needed. Your Zupass credentials become your ticket identity.</p>
    </div>
    <div class="roadmap-item">
      <span class="roadmap-tag">Wallets</span>
      <h3>Para wallet</h3>
      <p>Managed wallet option for users who don't have MetaMask. Create a wallet with just an email — onboard anyone.</p>
    </div>
    <div class="roadmap-item">
      <span class="roadmap-tag">Payments</span>
      <h3>Ticket payments</h3>
      <p>Accept payments for tickets — crypto and fiat. Set prices per series with built-in checkout.</p>
    </div>
    <div class="roadmap-item">
      <span class="roadmap-tag">Platform</span>
      <h3>WoCo Hub</h3>
      <p>A central place to discover events, manage your ticket passport, and connect with communities.</p>
    </div>
    <div class="roadmap-item">
      <span class="roadmap-tag">Embed</span>
      <h3>Advanced ticket widget</h3>
      <p>Embed ticket claiming on any website with a single script tag. Email claims work today — wallet claims, custom styling, and more claim modes coming soon.</p>
    </div>
    <div class="roadmap-item">
      <span class="roadmap-tag">Hosting</span>
      <h3>Portable frontends</h3>
      <p>Export your event page or user profile as a standalone site. Host it on your own domain, customise the look, and take your data with you.</p>
    </div>
    <div class="roadmap-item">
      <span class="roadmap-tag">Infra</span>
      <h3>Bring your own Bee node</h3>
      <p>Connect your own Swarm Bee node and postage batch. Full control over your storage — no reliance on our gateway.</p>
    </div>
  </div>
</section>

<!-- Footer -->
<footer class="home-footer">
  <p>Built on <a href="https://www.ethswarm.org" target="_blank" rel="noopener">Swarm</a> and <a href="https://ethereum.org" target="_blank" rel="noopener">Ethereum</a> standards</p>
  <p class="footer-links">
    <a href="https://github.com/yea-80y/WoCo-Event-App" target="_blank" rel="noopener">GitHub</a>
  </p>
</footer>

<style>
  /* Hero */
  .hero {
    text-align: center;
    padding: 3rem 0 2.5rem;
  }

  .hero-logo {
    width: 80px;
    height: 80px;
    border-radius: var(--radius-md);
    margin-bottom: 1.5rem;
    opacity: 0.9;
  }

  .hero h1 {
    font-size: 2rem;
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.02em;
    line-height: 1.2;
    margin: 0 0 0.75rem;
    max-width: 520px;
    margin-left: auto;
    margin-right: auto;
  }

  .hero-sub {
    font-size: 1rem;
    color: var(--text-secondary);
    line-height: 1.6;
    max-width: 480px;
    margin: 0 auto 1.75rem;
  }

  .hero-sub a {
    color: var(--accent-text);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .hero-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: center;
  }

  .btn-primary {
    padding: 0.625rem 1.5rem;
    font-size: 0.9375rem;
    font-weight: 600;
    background: var(--accent);
    color: #fff;
    border-radius: var(--radius-sm);
    transition: background var(--transition);
  }

  .btn-primary:hover {
    background: var(--accent-hover);
  }

  .btn-outline {
    padding: 0.625rem 1.5rem;
    font-size: 0.9375rem;
    font-weight: 500;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    transition: all var(--transition);
    text-decoration: none;
  }

  .btn-outline:hover {
    border-color: var(--accent);
    color: var(--accent-text);
  }

  /* How it works */
  .how-it-works {
    padding: 2.5rem 0;
    border-top: 1px solid var(--border);
  }

  .how-it-works h2,
  .features h2,
  .events-section h2,
  .coming-soon h2 {
    font-size: 1.375rem;
    font-weight: 700;
    color: var(--text);
    margin: 0 0 1.5rem;
    letter-spacing: -0.01em;
  }

  .steps {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 1.25rem;
  }

  .step {
    padding: 1.25rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .step-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    font-size: 0.8125rem;
    font-weight: 700;
    color: var(--accent-text);
    background: var(--accent-subtle);
    border-radius: 50%;
    margin-bottom: 0.625rem;
  }

  .step h3 {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
    margin: 0 0 0.375rem;
  }

  .step p {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    line-height: 1.5;
    margin: 0;
  }

  /* Features */
  .features {
    padding: 2.5rem 0;
    border-top: 1px solid var(--border);
  }

  .feature-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 1.25rem;
  }

  .feature {
    padding: 1.25rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .feature-icon {
    font-size: 1.5rem;
    margin-bottom: 0.5rem;
  }

  .feature h3 {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
    margin: 0 0 0.375rem;
  }

  .feature p {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    line-height: 1.5;
    margin: 0;
  }

  /* Events */
  .events-section {
    padding: 2.5rem 0;
    border-top: 1px solid var(--border);
  }

  .event-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 1.25rem;
  }

  .status {
    text-align: center;
    color: var(--text-muted);
    padding: 2rem 0;
  }

  .empty {
    text-align: center;
    padding: 2.5rem 0;
  }

  .empty p {
    margin: 0;
    color: var(--text-secondary);
  }

  .empty .sub {
    color: var(--text-muted);
    font-size: 0.875rem;
    margin-top: 0.25rem;
  }

  /* Coming soon */
  .coming-soon {
    padding: 2.5rem 0;
    border-top: 1px solid var(--border);
  }

  .roadmap-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 1rem;
  }

  .roadmap-item {
    padding: 1.125rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
  }

  .roadmap-tag {
    display: inline-block;
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--accent-text);
    background: var(--accent-subtle);
    padding: 0.125rem 0.5rem;
    border-radius: 9999px;
    margin-bottom: 0.5rem;
  }

  .roadmap-item h3 {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
    margin: 0 0 0.25rem;
  }

  .roadmap-item p {
    font-size: 0.8125rem;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
  }

  /* Footer */
  .home-footer {
    padding: 2rem 0;
    border-top: 1px solid var(--border);
    text-align: center;
  }

  .home-footer p {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0;
  }

  .home-footer a {
    color: var(--text-secondary);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .home-footer a:hover {
    color: var(--accent-text);
  }

  .footer-links {
    margin-top: 0.5rem;
    font-size: 0.8125rem;
  }

  .footer-links a {
    color: var(--text-muted);
    text-decoration: none;
    transition: color var(--transition);
  }

  .footer-links a:hover {
    color: var(--accent-text);
  }
</style>
