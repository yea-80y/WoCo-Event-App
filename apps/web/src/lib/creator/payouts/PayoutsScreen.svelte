<!--
  Payouts — where an organiser's money is, and when it lands (issue #93).

  The platform holds takings until after the event (docs/PAYOUTS.md), which is
  only defensible if the organiser can see exactly what is held, for which event,
  and on what date it releases. So this screen states the position first (three
  tiles), explains the rule in one sentence, and then shows every sale grouped
  under the event that earned it — including the ones that released early against
  Stripe's holding limit, which must be visible rather than silent.

  Never the word "escrow": Stripe reserves it for a legal arrangement this is not.
-->
<script lang="ts">
  import type { EventDirectoryEntry, ShopDirectoryEntry, PayoutsResponse } from "@woco/shared";
  import { onMount, onDestroy, untrack } from "svelte";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { getPayoutsSWR, getStripeDashboardUrl } from "../../api/payouts.js";
  import { getMyEventsSWR, getMyShopsSWR } from "../../api/creator-cache.js";
  import { getStripeAccountStatus } from "../../api/stripe.js";
  import StripeVerifyGate from "../events/StripeVerifyGate.svelte";
  import {
    groupPayouts,
    summarisePayouts,
    formatMinor,
    entryAmount,
    entryCurrency,
    entryStatusLabel,
    isConverted,
    releaseCountdown,
    formatDate,
    type PayoutGroup,
    type PayoutsFailure,
  } from "./payouts-model.js";
  import Banknote from "lucide-svelte/icons/banknote";
  import ChevronDown from "lucide-svelte/icons/chevron-down";
  import ExternalLink from "lucide-svelte/icons/external-link";
  import AlertCircle from "lucide-svelte/icons/circle-alert";
  import RefreshCw from "lucide-svelte/icons/refresh-cw";

  let payouts = $state<PayoutsResponse | null>(null);
  let loading = $state(true);
  /** Set when we have nothing to show. */
  let fatalError = $state<PayoutsFailure | null>(null);
  /** Set when a refresh failed but cached figures are still on screen. */
  let staleError = $state<PayoutsFailure | null>(null);
  let refreshing = $state(false);

  let stripeVerified = $state<boolean | null>(null);
  /**
   * The currency Stripe pays this organiser out in. Used only to render a
   * meaningful zero — "£0.00" rather than a currency they have never traded in.
   */
  let payoutCurrency = $state("gbp");
  let eventTitles = $state<Map<string, string>>(new Map());
  let shopTitles = $state<Map<string, string>>(new Map());
  let expanded = $state<Set<string>>(new Set());

  let dashboardBusy = $state(false);
  let dashboardError = $state<string | null>(null);

  let now = $state(Date.now());
  let clockTimer: ReturnType<typeof setInterval>;
  let lastRefreshedAt = 0;
  /** Discards results from a previous identity after a sign-out or account switch. */
  let loadToken = 0;

  // ── Derived view model ────────────────────────────────────────────────────
  const summary = $derived(payouts ? summarisePayouts(payouts) : null);
  const groups = $derived(
    payouts
      ? groupPayouts(payouts.entries, (kind, id) =>
          kind === "event" ? eventTitles.get(id) : shopTitles.get(id))
      : [],
  );
  const heldCurrencies = $derived(Object.entries(summary?.heldByCurrency ?? {}));
  const releasedCurrencies = $derived(Object.entries(summary?.releasedByCurrency ?? {}));
  const hasSales = $derived((payouts?.entries.length ?? 0) > 0);

  function toggle(key: string): void {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key); else next.add(key);
    expanded = next;
  }

  function groupTotalLine(g: PayoutGroup): string {
    const held = Object.entries(g.heldByCurrency);
    if (held.length > 0) return held.map(([cur, amt]) => formatMinor(amt, cur)).join(" · ");
    const released = Object.entries(g.releasedByCurrency);
    if (released.length > 0) return released.map(([cur, amt]) => formatMinor(amt, cur)).join(" · ");
    return "—";
  }

  // ── Loading ───────────────────────────────────────────────────────────────
  async function load(address: string, opts: { silent?: boolean } = {}): Promise<void> {
    const token = ++loadToken;
    if (!opts.silent) loading = true;
    refreshing = true;

    // Per-address localStorage must not paint before the session is verified —
    // same gate the rest of the creator portal uses.
    if (!auth.hasSession) {
      const ok = await auth.ensureSession();
      if (token !== loadToken) return;
      if (!ok) {
        loading = false;
        refreshing = false;
        fatalError = { kind: "auth", message: "Sign in again to see your payouts.", detail: "no session" };
        return;
      }
    }

    const swr = getPayoutsSWR(address);
    if (swr.cached && token === loadToken) {
      payouts = swr.cached;
      loading = false;
    }

    // Titles come from the creator's own cached lists — a group header should
    // never block on them, so failures leave the id-based fallback in place.
    const evSWR = getMyEventsSWR(address);
    const shopSWR = getMyShopsSWR(address);
    applyEventTitles(evSWR.cached);
    applyShopTitles(shopSWR.cached);
    evSWR.refresh().then((fresh) => { if (token === loadToken) applyEventTitles(fresh); });
    shopSWR.refresh().then((fresh) => { if (token === loadToken) applyShopTitles(fresh); });

    const result = await swr.refresh();
    if (token !== loadToken) return;

    if (result.ok) {
      payouts = result.data;
      fatalError = null;
      staleError = null;
      lastRefreshedAt = Date.now();
    } else if (payouts) {
      // Keep the last known figures on screen, but say they might be behind.
      staleError = result.error;
      console.warn("[payouts] refresh failed:", result.error.detail);
    } else {
      fatalError = result.error;
      console.warn("[payouts] load failed:", result.error.detail);
    }
    loading = false;
    refreshing = false;
  }

  function applyEventTitles(list: EventDirectoryEntry[] | null): void {
    if (!list?.length) return;
    const next = new Map(eventTitles);
    for (const e of list) if (e.title) next.set(e.eventId, e.title);
    eventTitles = next;
  }

  function applyShopTitles(list: ShopDirectoryEntry[] | null): void {
    if (!list?.length) return;
    const next = new Map(shopTitles);
    for (const s of list) if (s.name) next.set(s.shopId, s.name);
    shopTitles = next;
  }

  function reset(): void {
    loadToken++;
    payouts = null;
    fatalError = null;
    staleError = null;
    loading = false;
    stripeVerified = null;
    // Nothing from the previous account survives the switch — including the
    // event names its groups were labelled with.
    eventTitles = new Map();
    shopTitles = new Map();
    expanded = new Set();
    dashboardError = null;
  }

  async function openDashboard(): Promise<void> {
    dashboardBusy = true;
    dashboardError = null;
    const res = await getStripeDashboardUrl();
    if (res.ok) {
      // Stripe requires login links to be used immediately and never shared, so
      // we redirect the moment we have one and hold nothing.
      window.location.href = res.url;
      return;
    }
    dashboardError = res.error.message;
    dashboardBusy = false;
  }

  // Refresh when the organiser comes back to the tab — this is money, and they
  // often leave it open. Throttled so tab-flicking doesn't hammer the API.
  function onFocus(): void {
    const addr = auth.parent;
    if (!addr || !auth.isConnected) return;
    if (Date.now() - lastRefreshedAt < 30_000) return;
    void load(addr.toLowerCase(), { silent: true });
  }

  onMount(() => {
    clockTimer = setInterval(() => { now = Date.now(); }, 60_000);
    window.addEventListener("focus", onFocus);
  });

  onDestroy(() => {
    clearInterval(clockTimer);
    window.removeEventListener("focus", onFocus);
  });

  $effect(() => {
    // Track ONLY the identity. load() synchronously reads state it also
    // writes (eventTitles via applyEventTitles when the session is already
    // live), and a tracked read-write here is an infinite effect loop that
    // re-fires the API calls until the browser starves (found in testing:
    // effect_update_depth_exceeded + ERR_INSUFFICIENT_RESOURCES storm).
    const addr = auth.parent;
    const connected = auth.isConnected;
    untrack(() => {
      if (!connected || !addr) {
        reset();
        return;
      }
      // Stripe status decides between the "connect Stripe" gate and the real
      // screen; a failure here must not hide payouts we already hold.
      getStripeAccountStatus()
        .then((s) => {
          stripeVerified = !!s.onboardingComplete;
          if (s.defaultCurrency) payoutCurrency = s.defaultCurrency;
        })
        .catch(() => { stripeVerified = null; });
      void load(addr.toLowerCase());
    });
  });
</script>

<div class="payouts">

  <header class="head">
    <span class="kicker">PAYOUTS</span>
    <h1>Where your money is</h1>
    <p class="sub">
      Every ticket and shop sale, what it earned you, and the day it reaches your bank.
    </p>
  </header>

  {#if !auth.isConnected}
    <section class="panel panel--prompt">
      <Banknote size={22} strokeWidth={2} />
      <div>
        <h2>Sign in to see your payouts</h2>
        <p>Your takings are tied to your organiser account.</p>
      </div>
      <button class="btn btn--primary" onclick={() => loginRequest.request()}>Sign in</button>
    </section>

  {:else}

    {#if stripeVerified === false}
      <StripeVerifyGate
        bind:verified={stripeVerified}
        title="Connect Stripe to get paid"
        sub="Card payments settle into your own Stripe account, so payouts need a connected, verified account. It takes about five minutes."
      />
    {/if}

    <!-- ── Position ─────────────────────────────────────────────────────── -->
    <section class="tiles" aria-label="Payout summary">
      <div class="tile">
        <span class="tile-label mono">HELD FOR YOU</span>
        {#if loading && !payouts}
          <span class="tile-value mono skeleton">—</span>
        {:else if heldCurrencies.length === 0}
          <span class="tile-value mono">{formatMinor(0, payoutCurrency)}</span>
          <span class="tile-note">Nothing held right now</span>
        {:else}
          {#each heldCurrencies as [cur, amt] (cur)}
            <span class="tile-value mono">{formatMinor(amt, cur)}</span>
          {/each}
          <!-- Always an estimate: a held net is never final (a refund can still
               land before release), so there is no "Ready to release" state. -->
          <span class="tile-note">Estimated — a refund can still change it</span>
        {/if}
      </div>

      <div class="tile">
        <span class="tile-label mono">NEXT RELEASE</span>
        {#if summary?.nextReleaseAt}
          <span class="tile-value tile-value--date">{formatDate(summary.nextReleaseAt, now)}</span>
          <span class="tile-note">{releaseCountdown(summary.nextReleaseAt, now)}</span>
        {:else}
          <span class="tile-value tile-value--date tile-value--quiet">—</span>
          <span class="tile-note">Nothing due</span>
        {/if}
      </div>

      <div class="tile">
        <span class="tile-label mono">PAID OUT TO DATE</span>
        {#if releasedCurrencies.length === 0}
          <span class="tile-value mono tile-value--quiet">{formatMinor(0, payoutCurrency)}</span>
          <span class="tile-note">No payouts yet</span>
        {:else}
          {#each releasedCurrencies as [cur, amt] (cur)}
            <span class="tile-value mono">{formatMinor(amt, cur)}</span>
          {/each}
          <span class="tile-note">
            {summary?.releasedCount} {summary?.releasedCount === 1 ? "sale" : "sales"} released
          </span>
        {/if}
      </div>
    </section>

    <!-- ── The rule, in one sentence ────────────────────────────────────── -->
    <p class="rule">
      You're paid about two days after each event ends, and banks add another one to
      three days. Tickets sold more than roughly three months ahead release earlier —
      Stripe limits how long funds can be held.
    </p>

    <div class="actions">
      <button class="btn btn--ghost" onclick={openDashboard} disabled={dashboardBusy}>
        {#if dashboardBusy}Opening Stripe…{:else}Manage bank details{/if}
        <ExternalLink size={14} strokeWidth={2.25} />
      </button>
      <button
        class="link-quiet"
        onclick={() => auth.parent && load(auth.parent.toLowerCase(), { silent: true })}
        disabled={refreshing}
      >
        <RefreshCw size={13} strokeWidth={2.25} />
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>
    </div>

    {#if dashboardError}
      <p class="err" role="alert">{dashboardError}</p>
    {/if}

    {#if staleError}
      <div class="notice notice--warn" role="status">
        <AlertCircle size={15} strokeWidth={2.25} />
        <span>{staleError.message} These figures were last updated a moment ago.</span>
        <button class="link-quiet" onclick={() => auth.parent && load(auth.parent.toLowerCase(), { silent: true })}>
          Try again
        </button>
      </div>
    {/if}

    {#if summary && summary.convertedCount > 0}
      <p class="note">
        Some sales were charged in a different currency to your payout currency. Stripe
        converts those, and the amount shown is what reached your balance.
      </p>
    {/if}

    <!-- ── Sales ────────────────────────────────────────────────────────── -->
    {#if fatalError}
      <section class="panel panel--error" role="alert">
        <AlertCircle size={22} strokeWidth={2} />
        <div>
          <h2>{fatalError.message}</h2>
          <p>Nothing has been lost — this screen only reads your record.</p>
        </div>
        {#if fatalError.kind === "auth"}
          <button class="btn btn--primary" onclick={() => loginRequest.request()}>Sign in</button>
        {:else}
          <button class="btn btn--ghost" onclick={() => auth.parent && load(auth.parent.toLowerCase())}>
            Try again
          </button>
        {/if}
      </section>

    {:else if loading && !payouts}
      <div class="loading" aria-live="polite">Loading your sales…</div>

    {:else if !hasSales}
      <section class="panel panel--empty">
        <Banknote size={22} strokeWidth={2} />
        <div>
          <h2>Sales appear here as tickets sell</h2>
          <p>Each one shows what you earned and the date it releases to your bank.</p>
        </div>
      </section>

    {:else}
      <section class="groups" aria-label="Sales by event">
        {#each groups as g (g.key)}
          {@const open = expanded.has(g.key)}
          <article class="group" class:group--settled={!g.nextReleaseAt}>
            <button
              class="group-head"
              onclick={() => toggle(g.key)}
              aria-expanded={open}
              aria-controls="rows-{g.key}"
            >
              <span class="group-chev" class:open><ChevronDown size={16} strokeWidth={2.5} /></span>
              <span class="group-title">
                {g.title}
                {#if g.kind === "shop"}<span class="group-kind mono">SHOP</span>{/if}
              </span>
              <span class="group-meta">
                {#if g.nextReleaseAt}
                  <span class="group-when">Releases {releaseCountdown(g.nextReleaseAt, now)}</span>
                {:else}
                  <span class="group-when group-when--done">Settled</span>
                {/if}
                <span class="group-count mono">{g.entries.length} {g.entries.length === 1 ? "SALE" : "SALES"}</span>
              </span>
              <span class="group-total mono">{groupTotalLine(g)}</span>
            </button>

            {#if open}
              <ul class="rows" id="rows-{g.key}">
                {#each g.entries as e (e.sessionId)}
                  {@const label = entryStatusLabel(e, now)}
                  <li class="row row--{label.tone}">
                    <span class="row-dot" aria-hidden="true"></span>
                    <span class="row-date mono">{formatDate(e.recordedAt, now)}</span>
                    <span class="row-amount mono">{formatMinor(entryAmount(e), entryCurrency(e))}</span>
                    <span class="row-state">
                      <span class="row-badge">{label.badge}</span>
                      {#if e.forcedByCeiling}
                        <span
                          class="row-badge row-badge--early"
                          title="Stripe limits how long funds can be held — about 90 days from the sale — so this one was released before your event."
                        >Released early</span>
                      {/if}
                      <span class="row-detail">{label.detail}</span>
                    </span>
                    <span class="row-ref mono">
                      {#if isConverted(e)}
                        <span title="Charged in {e.currency.toUpperCase()}, paid out in {(e.settlementCurrency ?? '').toUpperCase()}">
                          {e.currency.toUpperCase()}→{(e.settlementCurrency ?? "").toUpperCase()}
                        </span>
                      {/if}
                      {#if e.payoutId}
                        <span title="Stripe payout {e.payoutId}">{e.payoutId.slice(-8)}</span>
                      {/if}
                    </span>
                  </li>
                {/each}
              </ul>
            {/if}
          </article>
        {/each}
      </section>
    {/if}
  {/if}
</div>

<style>
  .payouts {
    max-width: 760px;
    margin: 0 auto;
    padding: 1rem 1rem 4rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* ── Head ─────────────────────────────────────────────────────────── */
  .head h1 {
    font-family: var(--font-display);
    font-size: 1.5rem;
    letter-spacing: -0.02em;
    margin: 0.375rem 0 0;
    color: var(--text);
  }

  .sub {
    color: var(--text-muted);
    font-size: 0.8125rem;
    margin: 0.25rem 0 0;
    line-height: 1.5;
  }

  /* ── Tiles ────────────────────────────────────────────────────────── */
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 1px;
    background: var(--border);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .tile {
    background: var(--bg-surface);
    padding: 1rem 1.125rem 1.125rem;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }

  .tile-label {
    font-size: 0.625rem;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    margin-bottom: 0.5rem;
  }

  .tile-value {
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--accent);
    line-height: 1.15;
    letter-spacing: -0.02em;
    word-break: break-word;
  }

  .tile-value--date {
    font-family: var(--font-display);
    color: var(--text);
  }

  .tile-value--quiet { color: var(--text-dim); }

  .skeleton { color: var(--text-dim); }

  .tile-note {
    font-size: 0.6875rem;
    color: var(--text-muted);
    margin-top: 0.375rem;
    line-height: 1.4;
  }

  /* ── Explainer + actions ──────────────────────────────────────────── */
  .rule {
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.6;
    color: var(--text-secondary);
    border-left: 2px solid var(--accent);
    padding-left: 0.875rem;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .actions .btn { padding: 0.5rem 0.875rem; font-size: 0.8125rem; }

  .link-quiet {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    color: var(--text-muted);
    transition: color var(--transition);
  }
  .link-quiet:hover:not(:disabled) { color: var(--accent); }
  .link-quiet:disabled { opacity: 0.6; cursor: default; }

  .note {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.55;
    color: var(--text-muted);
  }

  .err {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--error);
  }

  .notice {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.625rem 0.875rem;
    border-radius: var(--radius-sm);
    font-size: 0.8125rem;
    line-height: 1.45;
  }

  .notice--warn {
    color: var(--warning);
    background: color-mix(in srgb, var(--warning) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--warning) 25%, var(--border));
  }

  .notice--warn span { flex: 1; min-width: 0; }
  .notice--warn .link-quiet { color: var(--warning); text-decoration: underline; }

  /* ── Panels (prompt / empty / error) ──────────────────────────────── */
  .panel {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1.5rem 1.25rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .panel > :global(svg) { color: var(--accent); flex-shrink: 0; }
  .panel--error > :global(svg) { color: var(--error); }

  .panel div { flex: 1; min-width: 0; }

  .panel h2 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
  }

  .panel p {
    margin: 0.25rem 0 0;
    font-size: 0.8125rem;
    color: var(--text-muted);
    line-height: 1.5;
  }

  .loading {
    padding: 2rem 0;
    text-align: center;
    font-size: 0.8125rem;
    color: var(--text-muted);
  }

  /* ── Groups ───────────────────────────────────────────────────────── */
  .groups {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .group {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-left: 2px solid var(--warning);
    border-radius: var(--radius-md);
    overflow: hidden;
    transition: border-color var(--transition);
  }

  /* The left edge is the state of the money: amber while held, quiet once
     everything in the group has settled. */
  .group--settled { border-left-color: var(--border-hover); }
  .group:hover { border-color: var(--border-hover); }
  .group:hover.group--settled { border-left-color: var(--border-hover); }

  .group-head {
    width: 100%;
    display: grid;
    grid-template-columns: auto 1fr auto;
    grid-template-areas:
      "chev title total"
      "chev meta  meta";
    align-items: center;
    gap: 0.125rem 0.75rem;
    padding: 0.875rem 1rem;
    text-align: left;
  }

  .group-head:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .group-chev {
    grid-area: chev;
    display: inline-flex;
    color: var(--text-muted);
    transition: transform var(--transition);
  }
  .group-chev.open { transform: rotate(180deg); color: var(--accent); }

  .group-title {
    grid-area: title;
    font-family: var(--font-display);
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .group-kind {
    font-size: 0.5625rem;
    letter-spacing: 0.12em;
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.0625rem 0.3125rem;
  }

  .group-meta {
    grid-area: meta;
    display: flex;
    align-items: center;
    gap: 0.625rem;
    font-size: 0.75rem;
    color: var(--text-muted);
    flex-wrap: wrap;
  }

  .group-when { color: var(--warning); }
  .group-when--done { color: var(--text-dim); }

  .group-count {
    font-size: 0.625rem;
    letter-spacing: 0.1em;
    color: var(--text-dim);
  }

  .group-total {
    grid-area: total;
    font-size: 1rem;
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
  }

  /* ── Rows ─────────────────────────────────────────────────────────── */
  .rows {
    list-style: none;
    margin: 0;
    padding: 0 1rem 0.75rem 1rem;
    display: flex;
    flex-direction: column;
  }

  .row {
    display: grid;
    grid-template-columns: 8px 4.5rem minmax(5rem, auto) 1fr auto;
    align-items: baseline;
    gap: 0.75rem;
    padding: 0.625rem 0;
    border-top: 1px solid var(--border);
    font-size: 0.8125rem;
  }

  .row-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    align-self: center;
    background: var(--warning);
  }
  .row--released .row-dot { background: var(--accent); }
  .row--void .row-dot { background: var(--text-dim); }

  .row-date { color: var(--text-muted); font-size: 0.75rem; }

  .row-amount { color: var(--text); font-weight: 600; }
  .row--void .row-amount { color: var(--text-dim); text-decoration: line-through; }

  .row-state {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    flex-wrap: wrap;
    min-width: 0;
  }

  .row-badge {
    font-family: var(--font-mono);
    font-size: 0.5625rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 0.125rem 0.375rem;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--warning) 12%, transparent);
    color: var(--warning);
    white-space: nowrap;
  }
  .row--released .row-badge {
    background: var(--accent-subtle);
    color: var(--accent-text);
  }
  .row--void .row-badge {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-dim);
  }

  /* The exposed tail (PAYOUTS §3.1) — always reads differently to a normal
     payout. Amber, not vermillion: this is a caveat about timing, not a fault. */
  .row--released .row-badge--early {
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
    color: var(--warning);
    cursor: help;
  }

  .row-detail {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .row-ref {
    display: flex;
    gap: 0.5rem;
    font-size: 0.625rem;
    color: var(--text-dim);
    white-space: nowrap;
  }

  /* ── Small screens ────────────────────────────────────────────────── */
  @media (max-width: 560px) {
    .row {
      grid-template-columns: 8px 1fr auto;
      grid-template-areas:
        "dot date  amount"
        "dot state state"
        "dot ref   ref";
      row-gap: 0.25rem;
    }
    .row-dot { grid-area: dot; }
    .row-date { grid-area: date; }
    .row-amount { grid-area: amount; text-align: right; }
    .row-state { grid-area: state; }
    .row-ref { grid-area: ref; }
    .row-ref:empty { display: none; }

    .group-total { font-size: 0.875rem; }
    .panel { flex-direction: column; align-items: flex-start; }
  }

  @media (prefers-reduced-motion: reduce) {
    .group-chev { transition: none; }
  }
</style>
