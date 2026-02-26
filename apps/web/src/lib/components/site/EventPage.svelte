<script lang="ts">
  import type { EventFeed, SeriesSummary, SealedBox } from "@woco/shared";
  import { sealJson } from "@woco/shared";
  import { getEvent, claimTicket, claimTicketByEmail } from "../../api/events.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { cacheGet, cacheSet, cacheKey, TTL } from "../../cache/cache.js";
  import { onMount } from "svelte";

  interface Props {
    eventId: string;
    ondashboard?: () => void;
  }

  let { eventId, ondashboard }: Props = $props();

  const BEE_GATEWAY =
    (typeof window !== "undefined" && window.SITE_CONFIG?.gatewayUrl) ||
    import.meta.env.VITE_GATEWAY_URL ||
    "https://gateway.woco-net.com";

  // ── Event loading ─────────────────────────────────────────────────────────
  const _KEY = cacheKey.event(eventId);
  const _cached = cacheGet<EventFeed>(_KEY);

  let event = $state<EventFeed | null>(_cached ?? null);
  let loading = $state(_cached === null);
  let error = $state<string | null>(null);

  // ── Ticket selection ──────────────────────────────────────────────────────
  let selectedSeries = $state<SeriesSummary | null>(null);

  // ── Claim flow state ──────────────────────────────────────────────────────
  let formData = $state<Record<string, string>>({});
  let inlineEmail = $state("");
  let chosenMethod = $state<"wallet" | "email" | null>(null);
  let claiming = $state(false);
  let claimStep = $state("");
  let claimError = $state<string | null>(null);
  let claimed = $state(false);
  let claimedEdition = $state<number | null>(null);
  let claimedVia = $state<"wallet" | "email" | null>(null);
  let approvalPending = $state(false);

  // ── Derived ───────────────────────────────────────────────────────────────
  const claimMode = $derived(event?.claimMode ?? "wallet");

  const hasOrderForm = $derived(!!event?.orderFields?.length && !!event?.encryptionKey);

  const hasEmailField = $derived(
    !!event?.orderFields?.some((f) => f.type === "email" || f.id === "__email")
  );

  const formValid = $derived(() => {
    if (!event?.orderFields?.length) return true;
    return event.orderFields.every(
      (f) => !f.required || (formData[f.id] ?? "").trim().length > 0
    );
  });

  // ── Sale window helpers ───────────────────────────────────────────────────
  function saleStatus(s: SeriesSummary): "active" | "future" | "past" {
    const now = Date.now();
    if (s.saleStart && new Date(s.saleStart).getTime() > now) return "future";
    if (s.saleEnd && new Date(s.saleEnd).getTime() < now) return "past";
    return "active";
  }

  function formatShortDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  // ── Ticket selection ──────────────────────────────────────────────────────
  function selectSeries(s: SeriesSummary) {
    if (saleStatus(s) !== "active") return;
    // Reset claim state when switching series
    if (selectedSeries?.seriesId !== s.seriesId) {
      claimed = false;
      claimedEdition = null;
      claimedVia = null;
      approvalPending = false;
      claimError = null;
      formData = {};
      inlineEmail = "";
      chosenMethod = null;
    }
    selectedSeries = s;
    // Scroll claim section into view
    setTimeout(() => {
      document.getElementById("claim-section")?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }, 0);
  }

  // ── Claim logic ───────────────────────────────────────────────────────────
  function getEmail(): string | null {
    const fromForm = formData["__email"]?.trim();
    if (fromForm?.includes("@")) return fromForm;
    if (event?.orderFields) {
      for (const f of event.orderFields) {
        if (f.type === "email") {
          const v = formData[f.id]?.trim();
          if (v?.includes("@")) return v;
        }
      }
    }
    const inline = inlineEmail.trim();
    if (inline?.includes("@")) return inline;
    return null;
  }

  function effectiveMethod(): "wallet" | "email" {
    if (claimMode === "wallet") return "wallet";
    if (claimMode === "email") return "email";
    return chosenMethod ?? (auth.isConnected ? "wallet" : "email");
  }

  async function handleClaim(method?: "wallet" | "email") {
    if (!selectedSeries || claiming) return;
    if (method) chosenMethod = method;

    claiming = true;
    claimError = null;

    try {
      const m = method ?? effectiveMethod();

      if (m === "email") {
        const email = getEmail();
        if (!email) {
          claimError = "Please enter a valid email address";
          return;
        }

        let encryptedOrder: SealedBox | undefined;
        if (event?.encryptionKey) {
          claimStep = "Encrypting your info…";
          encryptedOrder = await sealJson(event.encryptionKey, {
            ...(Object.keys(formData).length > 0 ? { fields: formData } : {}),
            seriesId: selectedSeries.seriesId,
            claimerEmail: email,
          });
        }

        claimStep = "Submitting…";
        const result = await claimTicketByEmail(
          eventId,
          selectedSeries.seriesId,
          email,
          encryptedOrder
        );

        if (!result.ok) {
          claimError = result.error || "Failed to register";
          return;
        }

        if (result.approvalPending) {
          approvalPending = true;
          return;
        }

        claimed = true;
        claimedEdition = result.edition ?? null;
        claimedVia = "email";
      } else {
        // Wallet claim
        if (!auth.isConnected) {
          claimStep = "Waiting for sign-in…";
          const ok = await loginRequest.request();
          if (!ok) {
            claimError = "Login cancelled";
            return;
          }
        }

        if (!auth.hasSession) {
          claimStep = "Approving session…";
          const ok = await auth.ensureSession();
          if (!ok) {
            claimError = "Session approval cancelled";
            return;
          }
        }

        let encryptedOrder: SealedBox | undefined;
        if (event?.encryptionKey) {
          claimStep = "Encrypting your info…";
          encryptedOrder = await sealJson(event.encryptionKey, {
            ...(Object.keys(formData).length > 0 ? { fields: formData } : {}),
            seriesId: selectedSeries.seriesId,
            claimerAddress: auth.parent,
          });
        }

        claimStep = "Registering…";
        const result = await claimTicket(
          eventId,
          selectedSeries.seriesId,
          auth.parent!,
          encryptedOrder
        );

        if (!result.ok) {
          claimError = result.error || "Failed to register";
          return;
        }

        if (result.approvalPending) {
          approvalPending = true;
          return;
        }

        claimed = true;
        claimedEdition = result.edition ?? null;
        claimedVia = "wallet";
      }
    } catch (e) {
      claimError = e instanceof Error ? e.message : "Unexpected error";
    } finally {
      claiming = false;
      claimStep = "";
    }
  }

  // ── Payment return handler ─────────────────────────────────────────────────
  function handlePaymentReturn() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("claimed") === "1") {
      claimed = true;
      claimedEdition = Number(params.get("edition")) || null;
      claimedVia = "wallet";
      // Clean up URL without triggering a navigation
      const cleanUrl = window.location.pathname + (window.location.hash || "");
      history.replaceState(null, "", cleanUrl);
    }
  }

  function handlePayment() {
    if (!selectedSeries?.paymentRedirectUrl) return;
    const email = getEmail() || "";
    const params = new URLSearchParams();
    if (email) params.set("email", email);
    if (auth.parent) params.set("walletAddress", auth.parent);
    params.set("returnUrl", window.location.href);
    const qs = params.toString();
    window.location.href = `${selectedSeries.paymentRedirectUrl}${qs ? "?" + qs : ""}`;
  }

  onMount(() => {
    handlePaymentReturn();
    getEvent(eventId)
      .then((fresh) => {
        if (!fresh) {
          if (_cached === null) error = "Event not found";
          loading = false;
          return;
        }
        cacheSet(_KEY, fresh, TTL.EVENT);
        event = fresh;
        loading = false;
        error = null;
      })
      .catch((e) => {
        if (_cached === null) {
          error = e instanceof Error ? e.message : "Failed to load event";
          loading = false;
        }
      });
  });
</script>

<div class="event-page">
  {#if loading}
    <div class="state-wrap">
      <div class="loader"></div>
      <p class="state-text">Loading event…</p>
    </div>
  {:else if error}
    <div class="state-wrap">
      <p class="state-error">{error}</p>
    </div>
  {:else if event}

    <!-- Banner image -->
    {#if event.imageHash}
      <div class="banner-wrap">
        <img
          src="{BEE_GATEWAY}/bytes/{event.imageHash}"
          alt={event.title}
          class="banner-img"
        />
        <div class="banner-fade"></div>
      </div>
    {/if}

    <!-- Event header -->
    <div class="event-header">
      <h1 class="event-title">{event.title}</h1>

      <div class="meta-row">
        <span class="meta-item">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
            <path d="M5 1v3M11 1v3M2 7h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          {formatDate(event.startDate)}
          {#if event.endDate && event.endDate !== event.startDate}
            <span class="meta-sep">–</span>
            {formatDate(event.endDate)}
          {/if}
        </span>

        {#if event.location}
          <span class="meta-item">
            <svg width="13" height="14" viewBox="0 0 14 16" fill="none" aria-hidden="true">
              <path d="M7 1C4.239 1 2 3.239 2 6c0 3.75 5 9 5 9s5-5.25 5-9c0-2.761-2.239-5-5-5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
              <circle cx="7" cy="6" r="1.5" stroke="currentColor" stroke-width="1.3"/>
            </svg>
            {event.location}
          </span>
        {/if}
      </div>

      {#if event.description}
        <p class="event-desc">{event.description}</p>
      {/if}
    </div>

    <!-- Organizer bar (only visible to the creator) -->
    {#if auth.parent?.toLowerCase() === event.creatorAddress.toLowerCase()}
      <div class="organizer-bar">
        <div class="organizer-bar-inner">
          <span class="organizer-label">You are the organizer</span>
          <button class="organizer-btn" onclick={ondashboard}>
            Dashboard →
          </button>
        </div>
      </div>
    {/if}

    <!-- Tickets -->
    <div class="tickets-section">
      <h2 class="tickets-heading">Tickets</h2>
      <div class="series-list">
        {#each event.series as s}
          {@const status = saleStatus(s)}
          {@const isSelected = selectedSeries?.seriesId === s.seriesId}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_interactive_supports_focus -->
          <div
            class="series-card"
            class:is-selected={isSelected}
            class:is-unavailable={status !== "active"}
            role={status === "active" ? "button" : "listitem"}
            onclick={() => selectSeries(s)}
          >
            <div class="series-info">
              <div class="series-name-row">
                <h3 class="series-name">{s.name}</h3>
                {#if s.wave}
                  <span class="wave-pill">{s.wave}</span>
                {/if}
              </div>
              {#if s.description}
                <p class="series-desc">{s.description}</p>
              {/if}
              <div class="series-meta-row">
                {#if status === "future"}
                  <span class="sale-tag sale-tag--future">
                    Opens {formatShortDate(s.saleStart!)}
                  </span>
                {:else if status === "past"}
                  <span class="sale-tag sale-tag--past">Sales closed</span>
                {:else}
                  <span class="series-supply">{s.totalSupply} tickets</span>
                  {#if s.saleEnd}
                    <span class="sale-tag sale-tag--active">Until {formatShortDate(s.saleEnd)}</span>
                  {/if}
                {/if}
              </div>
            </div>

            <div class="series-action">
              {#if status === "future"}
                <span class="select-btn select-btn--disabled">Coming soon</span>
              {:else if status === "past"}
                <span class="select-btn select-btn--disabled">Closed</span>
              {:else if isSelected}
                <span class="select-btn select-btn--selected">✓ Selected</span>
              {:else}
                <span class="select-btn">Select</span>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>

    <!-- Claim section — shown when a series is selected -->
    {#if selectedSeries}
      <div class="claim-section" id="claim-section">
        {#if claimed}
          <div class="claim-success">
            <span class="success-icon">✓</span>
            <div class="success-body">
              <p class="success-title">
                {claimedVia === "email" ? "Registration submitted!" : "Ticket claimed!"}
              </p>
              {#if claimedEdition != null}
                <p class="success-detail">Ticket #{claimedEdition} · {selectedSeries.name}</p>
              {/if}
              {#if claimedVia === "email"}
                <p class="success-note">Your ticket will be sent to you by the organizer.</p>
              {:else if claimedVia === "wallet"}
                <p class="success-note">Your ticket has been saved to your passport.</p>
              {/if}
            </div>
          </div>

        {:else if approvalPending}
          <div class="claim-pending">
            <span class="pending-dot">●</span>
            <div>
              <p class="pending-title">Request submitted — pending approval</p>
              <p class="pending-note">You'll receive your ticket once the organizer approves it.</p>
            </div>
          </div>

        {:else}
          <div class="claim-header">
            <h3 class="claim-title">
              Register for:
              <span class="claim-series-name">{selectedSeries.name}</span>
              {#if selectedSeries.wave}
                <span class="wave-pill">{selectedSeries.wave}</span>
              {/if}
            </h3>
          </div>

          <!-- Order form fields (shared for all ticket types) -->
          {#if hasOrderForm && event.orderFields}
            <div class="form-fields">
              {#each event.orderFields as field}
                <label class="form-field">
                  <span class="form-label">
                    {field.label || field.placeholder || field.type}
                    {#if field.required}<span class="required">*</span>{/if}
                  </span>
                  {#if field.type === "textarea"}
                    <textarea
                      bind:value={formData[field.id]}
                      placeholder={field.placeholder || ""}
                      maxlength={field.maxLength}
                      rows="3"
                    ></textarea>
                  {:else if field.type === "select" && field.options}
                    <select bind:value={formData[field.id]}>
                      <option value="">Select…</option>
                      {#each field.options as opt}
                        <option value={opt}>{opt}</option>
                      {/each}
                    </select>
                  {:else if field.type === "checkbox"}
                    <label class="checkbox-row">
                      <input
                        type="checkbox"
                        checked={formData[field.id] === "yes"}
                        onchange={(e) =>
                          (formData[field.id] = (e.target as HTMLInputElement).checked
                            ? "yes"
                            : "")}
                      />
                      <span>{field.placeholder || field.label}</span>
                    </label>
                  {:else}
                    <input
                      type={field.type}
                      bind:value={formData[field.id]}
                      placeholder={field.placeholder || ""}
                      maxlength={field.maxLength}
                    />
                  {/if}
                </label>
              {/each}
            </div>
          {/if}

          <!-- Inline email input (when claimMode=both and no email field in form) -->
          {#if claimMode === "both" && !hasEmailField}
            <label class="form-field">
              <span class="form-label">
                Email
                <span class="form-label-optional">(for email claim)</span>
              </span>
              <input type="email" bind:value={inlineEmail} placeholder="your@email.com" />
            </label>
          {/if}

          {#if claimError}
            <p class="claim-error">{claimError}</p>
          {/if}

          <div class="claim-actions">
            {#if claiming}
              <button class="claim-btn" disabled>{claimStep || "Processing…"}</button>
            {:else if selectedSeries.paymentRedirectUrl}
              <button
                class="claim-btn claim-btn--pay"
                onclick={handlePayment}
                disabled={!formValid()}
              >
                Register &amp; Pay
              </button>
            {:else if claimMode === "both"}
              <button
                class="claim-btn"
                onclick={() => handleClaim("wallet")}
                disabled={!formValid()}
              >
                {selectedSeries.approvalRequired ? "Request with wallet" : "Claim with wallet"}
              </button>
              <button
                class="claim-btn claim-btn--outline"
                onclick={() => handleClaim("email")}
                disabled={!formValid() || (!hasEmailField && !inlineEmail.trim())}
              >
                {selectedSeries.approvalRequired ? "Request with email" : "Claim with email"}
              </button>
            {:else if claimMode === "email"}
              <button
                class="claim-btn"
                onclick={() => handleClaim("email")}
                disabled={!formValid()}
              >
                {selectedSeries.approvalRequired ? "Request to attend" : "Claim with email"}
              </button>
            {:else}
              <button
                class="claim-btn"
                onclick={() => handleClaim("wallet")}
                disabled={!formValid()}
              >
                {selectedSeries.approvalRequired ? "Request to attend" : "Claim ticket"}
              </button>
            {/if}
          </div>

          {#if hasOrderForm}
            <p class="encrypt-note">Your info is encrypted — only the organizer can read it.</p>
          {/if}
        {/if}
      </div>
    {/if}

  {/if}
</div>

<style>
  .event-page {
    max-width: 640px;
    margin: 0 auto;
  }

  /* ── State ────────────────────────────────────────────────────────────────── */
  .state-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 5rem 0;
    gap: 1rem;
  }

  .loader {
    width: 1.25rem;
    height: 1.25rem;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.75s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .state-text { color: var(--text-muted); font-size: 0.9375rem; }
  .state-error { color: var(--error); font-size: 0.9375rem; text-align: center; }

  /* ── Banner ───────────────────────────────────────────────────────────────── */
  .banner-wrap {
    position: relative;
    width: 100%;
    height: 220px;
    border-radius: var(--radius-md);
    overflow: hidden;
    margin-bottom: 1.75rem;
  }

  .banner-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center;
    display: block;
  }

  .banner-fade {
    position: absolute;
    inset: auto 0 0 0;
    height: 40%;
    background: linear-gradient(to bottom, transparent, var(--bg));
    pointer-events: none;
  }

  /* ── Event header ─────────────────────────────────────────────────────────── */
  .event-header { margin-bottom: 1.75rem; }

  .event-title {
    font-size: 1.75rem;
    font-weight: 700;
    letter-spacing: -0.025em;
    color: var(--text);
    margin: 0 0 0.75rem;
    line-height: 1.2;
  }

  .meta-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem 1.25rem;
    margin-bottom: 1rem;
  }

  .meta-item {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.875rem;
    color: var(--text-secondary);
  }

  .meta-item svg { flex-shrink: 0; opacity: 0.6; }
  .meta-sep { color: var(--text-muted); margin: 0 0.1rem; }

  .event-desc {
    font-size: 0.9375rem;
    line-height: 1.7;
    color: var(--text-secondary);
    margin: 0;
    white-space: pre-wrap;
  }

  /* ── Organizer bar ────────────────────────────────────────────────────────── */
  .organizer-bar {
    margin-bottom: 1.75rem;
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--accent) 6%, transparent);
    padding: 0.75rem 1rem;
  }

  .organizer-bar-inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .organizer-label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--accent-text);
  }

  .organizer-btn {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--accent-text);
    padding: 0.375rem 0.75rem;
    border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
    border-radius: var(--radius-sm);
    transition: all var(--transition);
    white-space: nowrap;
  }

  .organizer-btn:hover {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }

  /* ── Tickets section ──────────────────────────────────────────────────────── */
  .tickets-section { margin-bottom: 2rem; }

  .tickets-heading {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-muted);
    margin: 0 0 0.625rem;
  }

  .series-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .series-card {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    padding: 1rem 1.125rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    transition: border-color var(--transition), opacity var(--transition),
      background var(--transition);
    cursor: pointer;
    text-align: left;
  }

  .series-card:not(.is-unavailable):hover {
    border-color: var(--border-hover);
    background: var(--bg-elevated);
  }

  .series-card.is-selected {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 5%, var(--bg-surface));
  }

  .series-card.is-unavailable {
    opacity: 0.45;
    cursor: default;
  }

  .series-info { min-width: 0; flex: 1; }

  .series-name-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-bottom: 0.125rem;
  }

  .series-name {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
    line-height: 1.3;
  }

  .wave-pill {
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.15rem 0.45rem;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--accent-text);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .series-desc {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0.125rem 0 0.25rem;
    line-height: 1.4;
  }

  .series-meta-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    flex-wrap: wrap;
    margin-top: 0.25rem;
  }

  .series-supply {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .sale-tag {
    font-size: 0.6875rem;
    font-weight: 500;
    padding: 0.125rem 0.4rem;
    border-radius: 9999px;
  }

  .sale-tag--future {
    background: color-mix(in srgb, #a78bfa 12%, transparent);
    color: #a78bfa;
  }

  .sale-tag--past {
    background: color-mix(in srgb, var(--text-muted) 12%, transparent);
    color: var(--text-muted);
  }

  .sale-tag--active {
    background: color-mix(in srgb, var(--success) 12%, transparent);
    color: var(--success);
  }

  .series-action { flex-shrink: 0; }

  .select-btn {
    display: inline-block;
    font-size: 0.8125rem;
    font-weight: 600;
    padding: 0.375rem 0.875rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--accent);
    color: var(--accent-text);
    white-space: nowrap;
    transition: all var(--transition);
  }

  .series-card:not(.is-unavailable):not(.is-selected):hover .select-btn {
    background: var(--accent);
    color: #fff;
  }

  .select-btn--selected {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }

  .select-btn--disabled {
    border-color: var(--border);
    color: var(--text-muted);
    opacity: 0.6;
  }

  /* ── Claim section ────────────────────────────────────────────────────────── */
  .claim-section {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1.5rem;
    background: var(--bg-surface);
    margin-top: 0.25rem;
  }

  .claim-header { margin-bottom: 1.25rem; }

  .claim-title {
    font-size: 1rem;
    font-weight: 600;
    color: var(--text);
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    line-height: 1.4;
  }

  .claim-series-name { color: var(--accent-text); }

  /* ── Order form ───────────────────────────────────────────────────────────── */
  .form-fields {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    margin-bottom: 1rem;
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .form-label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text-secondary);
  }

  .form-label-optional {
    font-weight: 400;
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .required { color: var(--error); margin-left: 0.125rem; }

  .form-field input,
  .form-field textarea,
  .form-field select {
    padding: 0.5rem 0.75rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 0.875rem;
    font-family: inherit;
    transition: border-color var(--transition);
    resize: vertical;
  }

  .form-field input:focus,
  .form-field textarea:focus,
  .form-field select:focus {
    outline: none;
    border-color: var(--accent);
  }

  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: var(--text-secondary);
    cursor: pointer;
  }

  /* ── Claim actions ────────────────────────────────────────────────────────── */
  .claim-actions {
    display: flex;
    gap: 0.625rem;
    flex-wrap: wrap;
    margin-top: 1.25rem;
  }

  .claim-btn {
    padding: 0.5625rem 1.375rem;
    font-size: 0.875rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: #fff;
    white-space: nowrap;
    transition: background var(--transition);
  }

  .claim-btn:hover:not(:disabled) { background: var(--accent-hover); }

  .claim-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .claim-btn--outline {
    background: transparent;
    border: 1px solid var(--accent);
    color: var(--accent-text);
  }

  .claim-btn--outline:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 10%, transparent); }

  .claim-btn--pay {
    background: #059669;
  }

  .claim-btn--pay:hover:not(:disabled) { background: #047857; }

  .claim-error {
    font-size: 0.8125rem;
    color: var(--error);
    margin: 0.75rem 0 0;
  }

  .encrypt-note {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin: 0.75rem 0 0;
  }

  /* ── Claim success ────────────────────────────────────────────────────────── */
  .claim-success {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
  }

  .success-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    background: color-mix(in srgb, var(--success) 15%, transparent);
    color: var(--success);
    font-size: 1rem;
    font-weight: 700;
    flex-shrink: 0;
  }

  .success-title {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
    margin: 0 0 0.25rem;
  }

  .success-detail {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    margin: 0 0 0.25rem;
  }

  .success-note {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0;
  }

  /* ── Claim pending ────────────────────────────────────────────────────────── */
  .claim-pending {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .pending-dot {
    color: #d97706;
    font-size: 0.5rem;
    margin-top: 0.3rem;
    flex-shrink: 0;
  }

  .pending-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: #d97706;
    margin: 0 0 0.25rem;
  }

  .pending-note {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0;
  }

  /* ── Responsive ───────────────────────────────────────────────────────────── */
  @media (max-width: 480px) {
    .series-card { flex-wrap: wrap; }
    .series-action { width: 100%; }
    .select-btn { display: block; text-align: center; width: 100%; }
    .banner-wrap { height: 160px; }
    .event-title { font-size: 1.375rem; }
    .claim-section { padding: 1.125rem; }
    .claim-actions { flex-direction: column; }
    .claim-btn { text-align: center; }
  }
</style>
