<!--
  CreatorHome — the /creator landing.
  Studio dashboard (not an events list). Three jobs for an organiser:
    1. Start something new (event / site)
    2. Pick up where you left off (drafts / pending approvals)
    3. Manage existing work (latest events + sites)
  Design spec: memory/project_ui_theming_direction.md
-->
<script lang="ts">
  import type { EventDirectoryEntry, SiteDirectoryEntry } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { getMyEventsSWR, getMySitesSWR } from "../../api/creator-cache.js";
  import { getPendingClaims } from "../../api/events.js";
  import { getStripeAccountStatus } from "../../api/stripe.js";
  import { navigate } from "../../router/router.svelte.js";
  import { onMount, onDestroy } from "svelte";
  import { isPastEvent } from "../../utils/events.js";
  import TicketStub from "../../components/icons/sprites/TicketStub.svelte";
  import CrtMonitor from "../../components/icons/sprites/CrtMonitor.svelte";
  import ArrowRight from "lucide-svelte/icons/arrow-right";
  import CalendarDays from "lucide-svelte/icons/calendar-days";
  import Monitor from "lucide-svelte/icons/monitor";
  import CodeSquare from "lucide-svelte/icons/code-xml";
  import Webhook from "lucide-svelte/icons/webhook";
  import Wallet from "lucide-svelte/icons/wallet";
  import Settings from "lucide-svelte/icons/settings-2";
  import Plus from "lucide-svelte/icons/plus";
  import AlertCircle from "lucide-svelte/icons/circle-alert";

  let events = $state<EventDirectoryEntry[]>([]);
  let sites = $state<SiteDirectoryEntry[]>([]);
  let pendingTotal = $state(0);
  let stripeReady = $state<boolean | null>(null);
  let loading = $state(true);
  let now = $state(Date.now());
  let clockTimer: ReturnType<typeof setInterval>;

  // Greeting — first name from address fallback
  const greeting = $derived.by(() => {
    const h = new Date().getHours();
    if (h < 5)  return "Working late";
    if (h < 12) return "Morning";
    if (h < 17) return "Afternoon";
    return "Evening";
  });

  // Client-side split so the stat counter stays accurate after events end
  const upcomingEvents = $derived(events.filter(e => !isPastEvent(e, now)));
  const eventsLive = $derived(upcomingEvents.length);

  onMount(async () => {
    clockTimer = setInterval(() => { now = Date.now(); }, 60_000);
    if (!auth.isConnected || !auth.parent) {
      loading = false;
      return;
    }
    const addr = auth.parent.toLowerCase();

    // SWR: paint from cache instantly, then patch with fresh data.
    const evSWR = getMyEventsSWR(addr);
    const siteSWR = getMySitesSWR(addr);
    if (evSWR.cached) events = evSWR.cached;
    if (siteSWR.cached) sites = siteSWR.cached;
    if (evSWR.cached || siteSWR.cached) loading = false;

    const [freshEvents, freshSites] = await Promise.all([evSWR.refresh(), siteSWR.refresh()]);
    // Only overwrite with fresh data when it has items OR we never had cached data.
    // An unexpected empty response (auth/identity mismatch) shouldn't wipe what the
    // user can see — keep the last-known-good cached view.
    if (freshEvents && (freshEvents.length > 0 || !evSWR.cached)) events = freshEvents;
    if (freshSites && (freshSites.length > 0 || !siteSWR.cached)) sites = freshSites;
    loading = false;

    // Pending approvals — only check upcoming events
    if (upcomingEvents.length > 0) {
      Promise.all(upcomingEvents.slice(0, 6).map(e =>
        getPendingClaims(e.eventId).catch(() => [])
      )).then(results => {
        pendingTotal = results.reduce((sum, list) => sum + (list?.length || 0), 0);
      });
    }
    getStripeAccountStatus().then(s => {
      stripeReady = !!s.onboardingComplete;
    }).catch(() => { stripeReady = false; });
  });

  onDestroy(() => clearInterval(clockTimer));

  // Quick suggestions — show only what's actionable
  const suggestions = $derived.by(() => {
    const out: Array<{ kind: string; label: string; href?: string; action?: () => void }> = [];
    if (auth.isConnected && pendingTotal > 0) {
      out.push({
        kind: "approvals",
        label: `${pendingTotal} attendee${pendingTotal === 1 ? "" : "s"} waiting for approval`,
        action: () => {
          const evt = events[0];
          if (evt) navigate(`/event/${evt.eventId}/dashboard`);
        },
      });
    }
    if (auth.isConnected && stripeReady === false) {
      out.push({
        kind: "stripe",
        label: "Finish Stripe onboarding to accept card payments",
        action: () => navigate("/creator/events"),
      });
    }
    if (auth.isConnected && events.length === 0 && sites.length === 0) {
      out.push({
        kind: "empty",
        label: "You're just starting out — try creating your first event",
        action: () => navigate("/site-builder"),
      });
    }
    return out;
  });

  // Upcoming events sorted soonest-first
  const latestEvents = $derived(
    [...upcomingEvents]
      .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime())
      .slice(0, 3)
  );
  const latestSites = $derived(sites.slice(0, 3));

  function fmtDate(d: string | number | undefined) {
    if (!d) return "—";
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return "—";
    return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
  }
</script>

<div class="studio">

  <!-- ── Hero stat strip ─────────────────────────────────────────────── -->
  <section class="hero">
    <div class="hero-row">
      <div class="hero-greet">
        <span class="kicker kicker--plain"><span class="kicker-tag">STUDIO //</span> CREATOR PORTAL</span>
        <h1>
          {greeting}{#if auth.parent}, <span class="addr mono">{auth.parent.slice(0, 6)}…{auth.parent.slice(-4)}</span>{/if}.
        </h1>
      </div>

      <div class="hero-stats" aria-label="Live stats">
        <div class="stat">
          <span class="stat-label mono">EVENTS LIVE</span>
          <span class="stat-num mono" class:hot={eventsLive > 0}>{loading ? "—" : String(eventsLive).padStart(2, "0")}</span>
        </div>
        <div class="stat">
          <span class="stat-label mono">YOUR SITES</span>
          <span class="stat-num mono" class:hot={sites.length > 0}>{loading ? "—" : String(sites.length).padStart(2, "0")}</span>
        </div>
        <div class="stat">
          <span class="stat-label mono">PENDING</span>
          <span class="stat-num mono" class:hot={pendingTotal > 0}>{String(pendingTotal).padStart(2, "0")}</span>
        </div>
      </div>
    </div>
  </section>

  {#if !auth.isConnected}
    <section class="signin-callout card">
      <div>
        <h2>Sign in to enter your studio</h2>
        <p>Connect your wallet, email, or passkey to start creating events and venue sites.</p>
      </div>
      <button class="btn btn--primary" onclick={() => loginRequest.request()}>Sign in</button>
    </section>
  {/if}

  <!-- ── Start Something ─────────────────────────────────────────────── -->
  <section class="block">
    <header class="block-head">
      <span class="kicker"><span class="kicker-tag">01 //</span> START SOMETHING</span>
      <h2>What are you making today?</h2>
    </header>

    <div class="action-grid">
      <button class="action action--primary" onclick={() => navigate("/site-builder")}>
        <span class="action-sprite"><TicketStub size={56} color="currentColor" /></span>
        <div class="action-body">
          <span class="action-label">Create an event</span>
          <span class="action-desc">Walk through the four-step builder — backend, branding, pages, deploy. From idea to live page.</span>
        </div>
        <span class="action-go"><ArrowRight size={20} strokeWidth={2.5} /></span>
      </button>

      <button class="action action--ghost" onclick={() => navigate("/creator/sites")}>
        <span class="action-sprite"><CrtMonitor size={56} color="currentColor" /></span>
        <div class="action-body">
          <span class="action-label">Build a venue site</span>
          <span class="action-desc">Your venue's home on the web. Multi-page, your domain, your brand — events embedded.</span>
        </div>
        <span class="action-go"><ArrowRight size={20} strokeWidth={2.5} /></span>
      </button>
    </div>
  </section>

  <!-- ── Pick up where you left off ──────────────────────────────────── -->
  {#if suggestions.length > 0}
    <section class="block">
      <header class="block-head">
        <span class="kicker"><span class="kicker-tag">02 //</span> PICK UP WHERE YOU LEFT OFF</span>
        <h2>Needs your attention</h2>
      </header>

      <ul class="suggestions">
        {#each suggestions as sug}
          <li>
            <button class="suggestion" onclick={sug.action}>
              <span class="suggestion-dot"><AlertCircle size={16} strokeWidth={2.25} /></span>
              <span class="suggestion-label">{sug.label}</span>
              <span class="suggestion-arrow"><ArrowRight size={16} strokeWidth={2.5} /></span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <!-- ── Your work ───────────────────────────────────────────────────── -->
  {#if auth.isConnected}
    <section class="block">
      <header class="block-head">
        <span class="kicker"><span class="kicker-tag">{suggestions.length > 0 ? "03" : "02"} //</span> YOUR WORK</span>
        <h2>Manage what's running</h2>
      </header>

      <div class="work-grid">
        <!-- Events panel -->
        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">
              <CalendarDays size={16} strokeWidth={2.25} />
              Events
            </span>
            <button class="link-quiet" onclick={() => navigate("/creator/events")}>
              See all →
            </button>
          </div>

          {#if loading}
            <div class="panel-empty">Loading…</div>
          {:else if latestEvents.length === 0}
            <div class="panel-empty">
              <span>No events yet.</span>
              <button class="inline-link" onclick={() => navigate("/site-builder")}>
                <Plus size={14} strokeWidth={2.5} /> Create one
              </button>
            </div>
          {:else}
            <ul class="row-list">
              {#each latestEvents as ev}
                <li>
                  <button class="row" onclick={() => navigate(`/creator/events/${ev.eventId}`)}>
                    <span class="row-main">
                      <span class="row-title">{ev.title}</span>
                      <span class="row-meta mono">
                        {fmtDate(ev.startDate)} · {ev.totalTickets} ticket{ev.totalTickets !== 1 ? "s" : ""}
                      </span>
                    </span>
                    <ArrowRight size={14} strokeWidth={2.5} />
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <!-- Sites panel -->
        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">
              <Monitor size={16} strokeWidth={2.25} />
              Sites
            </span>
            <button class="link-quiet" onclick={() => navigate("/creator/sites")}>
              See all →
            </button>
          </div>

          {#if loading}
            <div class="panel-empty">Loading…</div>
          {:else if latestSites.length === 0}
            <div class="panel-empty">
              <span>No sites yet.</span>
              <button class="inline-link" onclick={() => navigate("/creator/sites")}>
                <Plus size={14} strokeWidth={2.5} /> Build one
              </button>
            </div>
          {:else}
            <ul class="row-list">
              {#each latestSites as s}
                <li>
                  <button class="row" onclick={() => navigate("/creator/sites")}>
                    <span class="row-main">
                      <span class="row-title">{s.brandName || s.siteId}</span>
                      <span class="row-meta mono">
                        {s.deployedUrl ? "DEPLOYED" : "DRAFT"}
                      </span>
                    </span>
                    <ArrowRight size={14} strokeWidth={2.5} />
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      </div>
    </section>
  {/if}

  <!-- ── Tools ───────────────────────────────────────────────────────── -->
  <section class="block">
    <header class="block-head">
      <span class="kicker">
        <span class="kicker-tag">{suggestions.length > 0 ? "04" : (auth.isConnected ? "03" : "02")} //</span>
        TOOLS
      </span>
      <h2>The rest of the toolbox</h2>
    </header>

    <div class="tools-grid">
      <button class="tool" onclick={() => {
        if (upcomingEvents[0]) navigate(`/event/${upcomingEvents[0].eventId}/embed`);
        else navigate("/creator/events");
      }}>
        <CodeSquare size={20} strokeWidth={2.25} />
        <div>
          <span class="tool-label">Embed widget</span>
          <span class="tool-desc">Drop ticketing onto any site.</span>
        </div>
      </button>

      <button class="tool" onclick={() => {
        if (upcomingEvents[0]) navigate(`/creator/events/${upcomingEvents[0].eventId}`);
        else navigate("/creator/events");
      }}>
        <Webhook size={20} strokeWidth={2.25} />
        <div>
          <span class="tool-label">Webhooks</span>
          <span class="tool-desc">Pipe attendee data to your stack.</span>
        </div>
      </button>

      <button class="tool" onclick={() => navigate(auth.parent ? `/creator/profile/${auth.parent.toLowerCase()}` : "/creator/profile")}>
        <Wallet size={20} strokeWidth={2.25} />
        <div>
          <span class="tool-label">Wallet & payouts</span>
          <span class="tool-desc">Crypto and Stripe accounts.</span>
        </div>
      </button>

      <button class="tool" onclick={() => navigate("/creator/events")}>
        <Settings size={20} strokeWidth={2.25} />
        <div>
          <span class="tool-label">Settings</span>
          <span class="tool-desc">Defaults, sender info, identity.</span>
        </div>
      </button>
    </div>
  </section>

  <!-- ── Whats new ───────────────────────────────────────────────────── -->
  <section class="block whats-new">
    <header class="block-head">
      <span class="kicker">
        <span class="kicker-tag">{suggestions.length > 0 ? "05" : (auth.isConnected ? "04" : "03")} //</span>
        WHAT'S NEW
      </span>
      <h2>Recent updates</h2>
    </header>

    <ul class="changelog">
      <li>
        <span class="changelog-date mono">2026-05-12</span>
        <div>
          <strong>Per-ticket on-chain signing.</strong>
          Tickets now batch-claim on Base for unbeatable verification at the door.
        </div>
      </li>
      <li>
        <span class="changelog-date mono">2026-04-28</span>
        <div>
          <strong>Slot reservations &amp; composite ticket cards.</strong>
          Stripe buyers see beautiful PNG passes in their inbox seconds after paying.
        </div>
      </li>
      <li>
        <span class="changelog-date mono">2026-04-09</span>
        <div>
          <strong>Canonical request signing.</strong>
          Every authenticated call is now bound to its exact bytes — cryptographic audit Round 4 shipped.
        </div>
      </li>
    </ul>
  </section>
</div>

<style>
  /* ── Layout ─────────────────────────────────────────────────────── */

  .studio {
    max-width: 1100px;
    margin: 0 auto;
    padding: 0 1.25rem 4rem;
  }

  /* ── Hero strip ─────────────────────────────────────────────────── */

  .hero {
    padding: 1.5rem 0 2rem;
    border-bottom: 1px solid var(--border);
    margin-bottom: 2.5rem;
  }
  .hero-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 2rem;
    align-items: end;
  }
  @media (max-width: 720px) {
    .hero-row { grid-template-columns: 1fr; align-items: start; }
  }
  .hero-greet h1 {
    font-size: clamp(1.875rem, 4vw, 2.75rem);
    line-height: 1.05;
    margin: 0.625rem 0 0;
    letter-spacing: -0.035em;
  }
  .addr {
    font-size: 0.55em;
    color: var(--text-muted);
    font-weight: 400;
    vertical-align: 0.18em;
    margin-left: 0.25em;
  }
  .kicker-tag {
    color: var(--accent);
    font-family: var(--font-mono);
    font-weight: 700;
  }

  .hero-stats {
    display: flex;
    gap: 0.5rem;
  }
  .stat {
    display: flex;
    flex-direction: column;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--border);
    background: var(--bg-surface);
    min-width: 7rem;
  }
  .stat-label {
    font-size: 0.5625rem;
    letter-spacing: 0.16em;
    color: var(--text-muted);
    font-weight: 500;
  }
  .stat-num {
    font-size: 1.75rem;
    font-weight: 500;
    color: var(--text-dim);
    line-height: 1.1;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
  }
  .stat-num.hot {
    color: var(--accent);
  }
  @media (max-width: 720px) {
    .hero-stats { width: 100%; }
    .stat { flex: 1; min-width: 0; }
    .stat-num { font-size: 1.375rem; }
  }

  /* ── Sign-in callout (only when logged out) ─────────────────────── */

  .signin-callout {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 1rem;
    align-items: center;
    padding: 1.25rem;
    margin-bottom: 2.5rem;
  }
  .signin-callout h2 { font-size: 1.125rem; margin: 0; }
  .signin-callout p { color: var(--text-muted); margin: 0.25rem 0 0; font-size: 0.875rem; }
  @media (max-width: 560px) {
    .signin-callout { grid-template-columns: 1fr; }
  }

  /* ── Section block ──────────────────────────────────────────────── */

  .block {
    margin-bottom: 3rem;
  }
  .block-head {
    margin-bottom: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .block-head h2 {
    font-size: 1.375rem;
    margin: 0;
    letter-spacing: -0.025em;
  }
  .kicker {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-muted);
  }
  .kicker--plain::before { display: none; }

  /* ── Start Something ────────────────────────────────────────────── */

  .action-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }
  @media (max-width: 720px) {
    .action-grid { grid-template-columns: 1fr; }
  }
  .action {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 1.25rem;
    padding: 1.5rem;
    text-align: left;
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    transition: transform var(--transition-fast), background var(--transition), border-color var(--transition), color var(--transition);
  }
  .action--primary {
    background: var(--accent);
    color: var(--accent-ink);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .action--primary:hover { background: var(--accent-hover); transform: translateY(-1px); }
  .action--primary:active { transform: translateY(0); }
  .action--primary .action-desc { color: rgba(11, 11, 9, 0.7); }

  .action--ghost {
    background: var(--bg-surface);
    color: var(--text);
    border-color: var(--border);
  }
  .action--ghost:hover {
    border-color: var(--accent);
    color: var(--accent);
    transform: translateY(-1px);
  }
  .action--ghost:hover .action-desc { color: var(--accent); opacity: 0.82; }

  .action-sprite {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 3.5rem;
    height: 3.5rem;
  }
  .action-body { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
  .action-label {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 1.1875rem;
    letter-spacing: -0.015em;
  }
  .action-desc {
    font-size: 0.875rem;
    color: var(--text-muted);
    line-height: 1.4;
  }
  .action-go { display: inline-flex; opacity: 0.9; }

  /* ── Suggestions ────────────────────────────────────────────────── */

  .suggestions { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .suggestion {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.875rem 1rem;
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    text-align: left;
    transition: border-color var(--transition), background var(--transition);
  }
  .suggestion:hover { border-color: var(--border-hover); background: var(--bg-surface-hover); }
  .suggestion:hover { border-left-color: var(--accent-hover); }
  .suggestion-dot { color: var(--accent); display: inline-flex; }
  .suggestion-label { font-size: 0.9375rem; color: var(--text); }

  /* ── Your work ──────────────────────────────────────────────────── */

  .work-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }
  @media (max-width: 720px) {
    .work-grid { grid-template-columns: 1fr; }
  }
  .panel {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1rem 1rem 0.5rem;
  }
  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--border);
    margin-bottom: 0.5rem;
  }
  .panel-title {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-family: var(--font-mono);
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text);
  }
  .link-quiet {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    color: var(--text-muted);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    transition: color var(--transition);
  }
  .link-quiet:hover { color: var(--accent); }

  .row-list { list-style: none; padding: 0; margin: 0; }
  .row {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem 0.5rem;
    text-align: left;
    border-radius: var(--radius-sm);
    color: var(--text);
    transition: background var(--transition), color var(--transition);
  }
  .row:hover { background: var(--bg-surface-hover); color: var(--accent); }
  .row-main { display: flex; flex-direction: column; gap: 0.125rem; min-width: 0; }
  .row-title {
    font-size: 0.9375rem;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row-meta {
    font-size: 0.6875rem;
    color: var(--text-muted);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .panel-empty {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 1.25rem 0.5rem;
    color: var(--text-muted);
    font-size: 0.875rem;
  }
  .inline-link {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--accent);
    background: none;
    border: none;
    padding: 0;
    transition: color var(--transition);
  }
  .inline-link:hover { color: var(--accent-hover); }

  /* ── Tools ──────────────────────────────────────────────────────── */

  .tools-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 0.625rem;
  }
  .tool {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.75rem;
    align-items: start;
    padding: 1rem;
    text-align: left;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text-secondary);
    transition: border-color var(--transition), color var(--transition), background var(--transition);
  }
  .tool:hover { border-color: var(--accent); color: var(--text); background: var(--bg-surface); }
  .tool > :global(svg) { color: var(--accent); margin-top: 0.125rem; }
  .tool > div { display: flex; flex-direction: column; gap: 0.125rem; }
  .tool-label { font-size: 0.875rem; font-weight: 600; color: var(--text); }
  .tool-desc { font-size: 0.75rem; color: var(--text-muted); }

  /* ── Changelog ──────────────────────────────────────────────────── */

  .changelog { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.75rem; }
  .changelog li {
    display: grid;
    grid-template-columns: 7rem 1fr;
    gap: 1rem;
    padding: 0.75rem 0;
    border-bottom: 1px dashed var(--border);
  }
  .changelog li:last-child { border-bottom: none; }
  .changelog-date {
    font-size: 0.6875rem;
    color: var(--text-muted);
    letter-spacing: 0.05em;
  }
  .changelog strong { font-weight: 600; color: var(--text); display: block; margin-bottom: 0.125rem; font-size: 0.9375rem; }
  .changelog div { color: var(--text-muted); font-size: 0.875rem; line-height: 1.55; }
  @media (max-width: 560px) {
    .changelog li { grid-template-columns: 1fr; gap: 0.25rem; }
  }
</style>
