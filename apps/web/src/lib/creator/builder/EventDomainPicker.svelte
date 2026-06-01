<script lang="ts" module>
  /** Intent captured in the deploy step; the parent acts on it AFTER deploy (needs the contentHash). */
  export type EventDomainIntent =
    | { mode: "none" }
    | { mode: "new"; label: string; description?: string }
    | { mode: "existing"; label: string; willOverwrite: boolean };
</script>

<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { checkSubEnsLabel, getOwnedSubEns, type OwnedSubEnsName } from "../../api/sub-ens.js";
  import { getStripeAccountStatus } from "../../api/stripe.js";
  import StripeConnectModal from "../dashboard/StripeConnectModal.svelte";

  interface Props {
    intent?: EventDomainIntent;
    /** Parent can pre-fetch and pass; if undefined, picker self-checks. */
    stripeConnected?: boolean;
    onstripesetup?: () => void;
  }

  let { intent = $bindable<EventDomainIntent>({ mode: "none" }), stripeConnected, onstripesetup }: Props = $props();

  // ── Stripe gate (mirrors SubENSPicker) ───────────────────────────────────────
  let stripeStatus = $state<boolean | null>(null);
  let stripeModalOpen = $state(false);

  $effect(() => {
    if (stripeConnected !== undefined) { stripeStatus = stripeConnected; return; }
    if (!auth.isConnected) { stripeStatus = false; return; }
    stripeStatus = null;
    getStripeAccountStatus()
      .then((s) => { stripeStatus = !!(s.ok && s.onboardingComplete); })
      .catch(() => { stripeStatus = false; });
  });

  function openStripeSetup() {
    if (onstripesetup) { onstripesetup(); return; }
    if (!auth.isConnected) {
      loginRequest.request().then((ok) => { if (ok) stripeModalOpen = true; });
      return;
    }
    stripeModalOpen = true;
  }
  function onStripeConnected() { stripeStatus = true; stripeModalOpen = false; }

  // ── Mode selection ────────────────────────────────────────────────────────────
  type Mode = "none" | "new" | "existing";
  let mode = $state<Mode>("none");

  // New-name state
  let rawInput = $state("");
  let checkPhase = $state<"idle" | "checking" | "ok" | "taken" | "invalid">("idle");
  let checkMsg = $state("");
  let profileBio = $state("");
  let _timer: ReturnType<typeof setTimeout> | null = null;

  let previewLabel = $derived(rawInput.toLowerCase().trim());
  let previewEns = $derived(previewLabel ? `${previewLabel}.woco.eth` : "");

  function onInput() {
    if (_timer) clearTimeout(_timer);
    const val = rawInput.toLowerCase().trim();
    if (!val) { checkPhase = "idle"; checkMsg = ""; return; }
    checkPhase = "checking";
    _timer = setTimeout(() => runCheck(val), 380);
  }

  async function runCheck(label: string) {
    try {
      const res = await checkSubEnsLabel(label);
      if (rawInput.toLowerCase().trim() !== label) return; // stale
      if (!res.ok) { checkPhase = "invalid"; checkMsg = res.error ?? "Check failed"; return; }
      if (res.data!.available) { checkPhase = "ok"; checkMsg = ""; }
      else { checkPhase = "taken"; checkMsg = res.data!.reason ?? "already taken"; }
    } catch {
      if (rawInput.toLowerCase().trim() === label) { checkPhase = "invalid"; checkMsg = "Network error — try again"; }
    }
  }

  // Existing-name state
  type OwnedState = "idle" | "loading" | "ready" | "empty" | "error";
  let ownedState = $state<OwnedState>("idle");
  let ownedNames = $state<OwnedSubEnsName[]>([]);
  let selectedExisting = $state<string>("");

  async function loadOwned() {
    if (ownedState === "loading" || ownedState === "ready") return;
    ownedState = "loading";
    const res = await getOwnedSubEns();
    if (res.ok && res.data) {
      ownedNames = res.data.names;
      ownedState = ownedNames.length === 0 ? "empty" : "ready";
      if (ownedNames.length === 1) selectedExisting = ownedNames[0]!.label;
    } else {
      ownedState = "error";
    }
  }

  function selectMode(next: Mode) {
    mode = next;
    if (next === "existing") void loadOwned();
  }

  // ── Publish the chosen intent upward ──────────────────────────────────────────
  // "new" only commits a label once availability is confirmed (so deploy never
  // races ahead of an unclaimable name); otherwise the parent treats it as a no-op.
  $effect(() => {
    if (mode === "new") {
      intent = checkPhase === "ok"
        ? { mode: "new", label: previewLabel, description: profileBio.trim() || undefined }
        : { mode: "new", label: "" };
    } else if (mode === "existing") {
      intent = { mode: "existing", label: selectedExisting, willOverwrite: !!selectedExisting };
    } else {
      intent = { mode: "none" };
    }
  });
</script>

{#if stripeStatus !== true}
  <!-- ── Stripe gate ─────────────────────────────────────────────────────── -->
  <div class="dp dp--locked">
    {#if stripeStatus === null}
      <div class="lock-loading">
        <span class="spinner" aria-label="Checking…"></span>
        <span class="muted-sm">Checking your account…</span>
      </div>
    {:else}
      <div class="lock-body">
        <span class="lock-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <rect x="4" y="8" width="10" height="8" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
            <path d="M6 8V6a3 3 0 0 1 6 0v2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
            <circle cx="9" cy="12" r="1.2" fill="currentColor"/>
          </svg>
        </span>
        <div class="lock-text">
          <p class="dp-title">Give this event a <code class="inline-code">.woco.eth</code> address</p>
          <p class="muted-sm">
            {#if !auth.isConnected}Connect your wallet to get started.
            {:else}Verify your business via Stripe to unlock — takes 2 minutes.{/if}
          </p>
        </div>
        <button class="setup-btn" onclick={openStripeSetup}>
          {#if !auth.isConnected}Connect wallet →{:else}Set up Stripe →{/if}
        </button>
      </div>
    {/if}
  </div>

  {#if stripeModalOpen && !onstripesetup}
    <StripeConnectModal bind:open={stripeModalOpen} onconnected={onStripeConnected} />
  {/if}

{:else}
  <!-- ── Picker ──────────────────────────────────────────────────────────── -->
  <div class="dp">
    <div class="dp-head">
      <span class="ens-badge" aria-hidden="true">
        <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
          <path d="M7.5 1L9.5 5.5H14.5L10.5 8.5L12 13.5L7.5 10.5L3 13.5L4.5 8.5L0.5 5.5H5.5L7.5 1Z"
                fill="#C7F23A" opacity="0.12" stroke="#C7F23A" stroke-width="1.2" stroke-linejoin="round"/>
        </svg>
        ENS
      </span>
      <div class="dp-head-text">
        <p class="dp-title">Web3 address for this event <span class="dp-opt">optional</span></p>
        <p class="muted-sm">Point a permanent <code class="inline-code">.woco.eth</code> name at this event's page once it deploys.</p>
      </div>
    </div>

    <!-- Option rows -->
    <div class="opts" role="radiogroup" aria-label="Sub-ENS for this event">
      <!-- None -->
      <button type="button" class="opt" class:opt--active={mode === "none"} role="radio" aria-checked={mode === "none"} onclick={() => selectMode("none")}>
        <span class="opt-dot" aria-hidden="true"></span>
        <span class="opt-label">No web3 address</span>
        <span class="opt-sub">Skip — deploy without an ENS name.</span>
      </button>

      <!-- New -->
      <button type="button" class="opt" class:opt--active={mode === "new"} role="radio" aria-checked={mode === "new"} onclick={() => selectMode("new")}>
        <span class="opt-dot" aria-hidden="true"></span>
        <span class="opt-label">Claim a new name</span>
        <span class="opt-sub">Register a fresh <code class="inline-code">.woco.eth</code> for this event — free, on Arbitrum.</span>
      </button>

      {#if mode === "new"}
        <div class="opt-body">
          <div class="input-wrap" class:input-wrap--ok={checkPhase === "ok"} class:input-wrap--bad={checkPhase === "taken" || checkPhase === "invalid"}>
            <input class="label-input" type="text" placeholder="my-event" autocomplete="off" autocapitalize="none" spellcheck="false"
              bind:value={rawInput} oninput={onInput} />
            <span class="tld-suffix">.woco.eth</span>
            <span class="check-indicator" aria-live="polite">
              {#if checkPhase === "checking"}<span class="spinner" aria-label="Checking…"></span>
              {:else if checkPhase === "ok"}
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="Available" role="img">
                  <circle cx="8" cy="8" r="7" fill="#22c55e" opacity="0.15"/><path d="M5 8.2l2.2 2.2L11 6" stroke="#22c55e" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              {:else if checkPhase === "taken"}
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="Taken" role="img">
                  <circle cx="8" cy="8" r="7" fill="#ef4444" opacity="0.12"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#ef4444" stroke-width="1.6" stroke-linecap="round"/>
                </svg>
              {:else if checkPhase === "invalid"}
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="Invalid" role="img">
                  <circle cx="8" cy="8" r="7" fill="#f59e0b" opacity="0.12"/><path d="M8 5v4M8 10.5v.5" stroke="#f59e0b" stroke-width="1.6" stroke-linecap="round"/>
                </svg>
              {/if}
            </span>
          </div>

          {#if checkPhase === "ok"}
            <p class="msg msg--ok">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2 6.2l2.8 2.8L10 4" stroke="#22c55e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              Available — set as your address on deploy.
            </p>
          {:else if checkPhase === "taken"}
            <p class="msg msg--bad">{checkMsg || "Already taken — try a different name"}</p>
          {:else if checkPhase === "invalid"}
            <p class="msg msg--warn">{checkMsg}</p>
          {/if}

          {#if checkPhase === "ok"}
            <input class="bio-input" type="text" maxlength="160" placeholder="Short bio (optional) — stored as an ENS text record" bind:value={profileBio} />
          {/if}
        </div>
      {/if}

      <!-- Existing -->
      <button type="button" class="opt" class:opt--active={mode === "existing"} role="radio" aria-checked={mode === "existing"} onclick={() => selectMode("existing")}>
        <span class="opt-dot" aria-hidden="true"></span>
        <span class="opt-label">Use a name I own</span>
        <span class="opt-sub">Repoint one of your existing names at this event.</span>
      </button>

      {#if mode === "existing"}
        <div class="opt-body">
          {#if ownedState === "loading"}
            <div class="lock-loading"><span class="spinner"></span><span class="muted-sm">Loading your names…</span></div>
          {:else if ownedState === "error"}
            <p class="msg msg--warn">Couldn't load your names. <button class="link-btn" onclick={() => { ownedState = "idle"; loadOwned(); }}>Retry</button></p>
          {:else if ownedState === "empty"}
            <p class="muted-sm">You don't own any <code class="inline-code">.woco.eth</code> names yet — choose “Claim a new name” above.</p>
          {:else if ownedState === "ready"}
            <div class="name-list">
              {#each ownedNames as n (n.label)}
                <button type="button" class="name-chip" class:name-chip--active={selectedExisting === n.label} onclick={() => selectedExisting = n.label}>
                  <span class="name-chip-mark" aria-hidden="true"></span>
                  <span class="name-chip-text">{n.ensName}</span>
                </button>
              {/each}
            </div>
            {#if selectedExisting}
              <p class="msg msg--warn">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M6 1v7M2 5l4 3 4-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M1 10h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
                <code class="inline-code">{selectedExisting}.woco.eth</code> will repoint to this event — replacing wherever it points now.
              </p>
            {/if}
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .dp {
    border: 1px solid var(--border);
    border-left: 3px solid #C7F23A;
    border-radius: 6px;
    background: var(--bg-elevated);
    padding: 1.25rem 1.375rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .dp--locked { border-left-color: var(--border); }

  .lock-loading { display: flex; align-items: center; gap: 0.625rem; }
  .muted-sm { font-size: 0.8125rem; color: var(--text-muted); line-height: 1.5; }

  .lock-body { display: grid; grid-template-columns: auto 1fr; gap: 0.5rem 0.75rem; align-items: center; }
  .lock-icon, .ens-badge { align-self: start; }
  .lock-icon {
    display: flex; align-items: center; justify-content: center;
    width: 2rem; height: 2rem; color: var(--text-muted);
    background: color-mix(in srgb, currentColor 8%, var(--bg));
    border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
    border-radius: 50%; grid-row: span 1;
  }
  .lock-text { grid-column: 2; }
  .setup-btn {
    grid-column: 2; justify-self: start; margin-top: 0.25rem;
    padding: 0.5625rem 0.875rem; font-size: 0.875rem; font-weight: 600;
    color: var(--text); background: transparent; border: 1.5px solid var(--border);
    border-radius: 5px; transition: border-color 120ms, color 120ms; cursor: pointer;
  }
  .setup-btn:hover { border-color: #C7F23A; color: #C7F23A; }

  /* ── Header ── */
  .dp-head { display: flex; align-items: flex-start; gap: 0.75rem; }
  .ens-badge {
    display: flex; align-items: center; gap: 0.3rem;
    padding: 0.2rem 0.5rem 0.2rem 0.35rem; font-size: 0.6875rem; font-weight: 800;
    letter-spacing: 0.08em; color: #C7F23A;
    background: color-mix(in srgb, #C7F23A 8%, transparent);
    border: 1px solid color-mix(in srgb, #C7F23A 22%, transparent);
    border-radius: 3px; white-space: nowrap; margin-top: 0.125rem;
  }
  .dp-head-text { display: flex; flex-direction: column; gap: 0.2rem; }
  .dp-title { margin: 0; font-size: 0.9375rem; font-weight: 700; color: var(--text); letter-spacing: -0.02em; }
  .dp-opt { font-size: 0.6875rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-left: 0.4rem; opacity: 0.7; }

  .inline-code {
    font-family: monospace; font-size: 0.85em; color: var(--text);
    background: color-mix(in srgb, #C7F23A 7%, var(--bg));
    border: 1px solid color-mix(in srgb, #C7F23A 14%, transparent);
    border-radius: 3px; padding: 0.1em 0.3em;
  }

  /* ── Option rows (radio-cards) ── */
  .opts { display: flex; flex-direction: column; gap: 0.5rem; }
  .opt {
    display: grid; grid-template-columns: auto 1fr; gap: 0.1rem 0.625rem;
    text-align: left; padding: 0.75rem 0.875rem; cursor: pointer;
    background: var(--bg); border: 1.5px solid var(--border); border-radius: 6px;
    transition: border-color 130ms, background 130ms;
  }
  .opt:hover { border-color: color-mix(in srgb, #C7F23A 40%, var(--border)); }
  .opt--active { border-color: #C7F23A; background: color-mix(in srgb, #C7F23A 5%, var(--bg)); }
  .opt-dot {
    grid-row: span 2; align-self: center; width: 16px; height: 16px; border-radius: 50%;
    border: 1.5px solid var(--border); position: relative; transition: border-color 130ms;
  }
  .opt--active .opt-dot { border-color: #C7F23A; }
  .opt--active .opt-dot::after {
    content: ""; position: absolute; inset: 3px; border-radius: 50%; background: #C7F23A;
  }
  .opt-label { font-size: 0.875rem; font-weight: 700; color: var(--text); letter-spacing: -0.01em; }
  .opt-sub { font-size: 0.78125rem; color: var(--text-muted); line-height: 1.4; }

  /* ── Expanded body ── */
  .opt-body {
    display: flex; flex-direction: column; gap: 0.625rem;
    padding: 0.875rem; margin: -0.125rem 0 0.125rem;
    background: color-mix(in srgb, #C7F23A 3%, var(--bg));
    border: 1px solid color-mix(in srgb, #C7F23A 12%, var(--border)); border-radius: 5px;
  }

  .input-wrap {
    display: flex; align-items: center; background: var(--bg-elevated);
    border: 1.5px solid var(--border); border-radius: 5px; overflow: hidden; transition: border-color 140ms;
  }
  .input-wrap:focus-within { border-color: #C7F23A; }
  .input-wrap--ok { border-color: color-mix(in srgb, #22c55e 60%, var(--border)); }
  .input-wrap--bad { border-color: color-mix(in srgb, #ef4444 50%, var(--border)); }
  .label-input {
    flex: 1; min-width: 0; padding: 0.6rem 0.375rem 0.6rem 0.75rem;
    font-size: 0.9375rem; font-family: monospace; font-weight: 600; color: var(--text);
    background: transparent; border: none; outline: none; letter-spacing: 0.01em;
  }
  .label-input::placeholder { color: var(--text-muted); opacity: 0.5; font-weight: 400; }
  .tld-suffix { font-size: 0.8125rem; font-family: monospace; color: var(--text-muted); padding-right: 0.5rem; white-space: nowrap; opacity: 0.65; }
  .check-indicator { display: flex; align-items: center; padding: 0 0.625rem 0 0.25rem; width: 1.875rem; flex-shrink: 0; }

  .bio-input {
    width: 100%; box-sizing: border-box; padding: 0.5rem 0.6875rem; font-size: 0.8125rem;
    color: var(--text); background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: 4px; outline: none; transition: border-color 130ms; font-family: inherit;
  }
  .bio-input:focus { border-color: #C7F23A; }

  .msg { margin: 0; display: flex; align-items: center; gap: 0.375rem; font-size: 0.8125rem; line-height: 1.4; }
  .msg--ok { color: #22c55e; }
  .msg--bad { color: #ef4444; }
  .msg--warn { color: #f59e0b; }
  .msg svg { flex-shrink: 0; }

  /* ── Owned name chips ── */
  .name-list { display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .name-chip {
    display: inline-flex; align-items: center; gap: 0.4rem;
    padding: 0.375rem 0.625rem; cursor: pointer; font-family: monospace; font-size: 0.8125rem; font-weight: 600;
    color: var(--text-muted); background: var(--bg-elevated);
    border: 1.5px solid var(--border); border-radius: 5px; transition: all 130ms;
  }
  .name-chip:hover { border-color: color-mix(in srgb, #C7F23A 40%, var(--border)); color: var(--text); }
  .name-chip--active { border-color: #C7F23A; color: var(--text); background: color-mix(in srgb, #C7F23A 7%, var(--bg)); }
  .name-chip-mark { width: 12px; height: 12px; border-radius: 50%; border: 1.5px solid var(--border); position: relative; flex-shrink: 0; }
  .name-chip--active .name-chip-mark { border-color: #C7F23A; }
  .name-chip--active .name-chip-mark::after { content: ""; position: absolute; inset: 2px; border-radius: 50%; background: #C7F23A; }

  .link-btn { color: #C7F23A; text-decoration: underline; cursor: pointer; background: none; border: none; padding: 0; font: inherit; }

  .spinner {
    display: inline-block; width: 13px; height: 13px;
    border: 1.5px solid color-mix(in srgb, #C7F23A 30%, var(--border));
    border-top-color: #C7F23A; border-radius: 50%; animation: spin 0.55s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
