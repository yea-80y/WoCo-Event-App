<script lang="ts">
  /**
   * Route A landing — target of the "Add to WoCo" button in ticket emails
   * (#/signup?gt={token}, docs/ATTENDEE_GATE_RESALE_PLAN.md §3).
   *
   * The token rides in the hash fragment so it never hits a server on page
   * load; we POST it to /token-info (unauthenticated) to show WHICH ticket is
   * being added, then to /redeem once an account exists. First click wins, so
   * a consumed token gets its own screen. An expired or broken link has no
   * in-app fallback: the ticket-proof form went with the v1 claim rail.
   */
  import { navigate } from "../../router/router.svelte.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { gate } from "./gate.svelte.js";
  import {
    getGateTokenInfo,
    redeemGateToken,
    type GateTokenInfo,
  } from "../../api/attendee-gate.js";

  interface Props {
    token?: string;
  }
  let { token }: Props = $props();

  type Phase =
    | "loading"
    | "no-token"
    | "ready"
    | "linking"
    | "done"
    | "consumed"
    | "expired"
    | "invalid";

  let phase = $state<Phase>("loading");
  let info = $state<GateTokenInfo | null>(null);
  let errorMsg = $state("");

  let loadToken = 0;
  $effect(() => {
    void load(token);
  });

  async function load(t?: string) {
    const my = ++loadToken;
    if (!t) {
      phase = "no-token";
      return;
    }
    phase = "loading";
    try {
      const resp = await getGateTokenInfo(t);
      if (my !== loadToken) return;
      if (resp.ok && resp.data) {
        info = resp.data;
        phase = resp.data.consumed ? "consumed" : "ready";
        // A used link may be this account's own ticket; the status says whose.
        if (resp.data.consumed) void gate.refresh();
      } else {
        phase = (resp.error ?? "").toLowerCase().includes("expired") ? "expired" : "invalid";
      }
    } catch {
      if (my !== loadToken) return;
      errorMsg = "Couldn't reach WoCo. Check your connection and refresh.";
      phase = "invalid";
    }
  }

  async function linkTicket() {
    if (!token || phase === "linking") return;
    errorMsg = "";

    if (!auth.isConnected) {
      const ok = await loginRequest.request({ context: "ticket" });
      if (!ok) return;
    }

    phase = "linking";
    try {
      const sessionOk = await auth.ensureSession();
      if (!sessionOk) {
        phase = "ready";
        errorMsg = "Couldn't set up this device. Try again.";
        return;
      }

      // The binding's owner of record is the VERIFIED session parent, stamped
      // server-side. Nothing identity-shaped is sent from here (#518): the
      // self-declared holder key that used to ride along proved nothing (#345).
      const resp = await redeemGateToken(token);
      if (resp.ok) {
        void gate.refresh();
        phase = "done";
      } else if ((resp.error ?? "").includes("already unlocked")) {
        phase = "consumed";
      } else {
        phase = "ready";
        errorMsg = resp.error ?? "Couldn't add your ticket. Try again.";
      }
    } catch (err) {
      phase = "ready";
      errorMsg = err instanceof Error ? err.message : "Couldn't reach WoCo. Try again.";
    }
  }

  async function plainSignIn() {
    if (!auth.isConnected && !(await loginRequest.request({ context: "attendee" }))) return;
    navigate("/tickets");
  }

  // Whether the ticket this link names is in the signed-in account, not merely
  // whether that account is unlocked by some other ticket.
  const inThisAccount = $derived.by(() => {
    const ticket = info;
    return !!ticket && !!gate.status?.bindings.some(
      (b) => b.seriesId === ticket.seriesId && b.edition === ticket.edition,
    );
  });

  const editionStr = $derived(
    info ? String(info.edition).padStart(3, "0") : "",
  );
  const dateStr = $derived(
    info?.eventDate
      ? new Date(info.eventDate).toLocaleDateString("en-GB", {
          weekday: "short",
          day: "numeric",
          month: "long",
          year: "numeric",
        })
      : null,
  );
</script>

<div class="signup-root">
  <p class="kicker"><span class="kicker-prefix">//</span> WELCOME TO WOCO</p>

  {#if phase === "loading"}
    <div class="pending"><span class="spinner"></span> Checking your ticket…</div>

  {:else if phase === "no-token"}
    <h1 class="headline">Add a ticket to <span class="hl-accent">WoCo</span>.</h1>
    <p class="sub">
      Open the email with your ticket and tap Add to WoCo. It brings you back
      here with your ticket ready to add.
    </p>
    <div class="actions">
      <button class="primary-btn" onclick={() => navigate("/discover")}>Explore events</button>
    </div>

  {:else if phase === "ready" || phase === "linking"}
    <h1 class="headline">
      You're going{info?.eventTitle ? " to" : ""}
      {#if info?.eventTitle}<span class="hl-accent">{info.eventTitle}</span>{/if}.
    </h1>
    <p class="sub">
      Add this ticket to WoCo to keep it in your passport and claim your own name.
    </p>

    {#if info}
      <div class="ticket-card">
        <div class="tc-row">
          <span class="tc-pill">#{editionStr}</span>
          <div class="tc-meta">
            <span class="tc-title">{info.eventTitle ?? "Event ticket"}</span>
            {#if dateStr}<span class="tc-line">{dateStr}</span>{/if}
            {#if info.eventLocation}<span class="tc-line">{info.eventLocation}</span>{/if}
            {#if info.seriesName}<span class="tc-line tc-muted">{info.seriesName}</span>{/if}
          </div>
        </div>
      </div>
    {/if}

    {#if errorMsg}<p class="err-box">{errorMsg}</p>{/if}

    <div class="actions">
      <button class="primary-btn" onclick={linkTicket} disabled={phase === "linking"}>
        {#if phase === "linking"}
          <span class="spinner spinner--dark"></span> Adding your ticket…
        {:else if auth.isConnected}
          Add to my passport
        {:else}
          Add to WoCo
        {/if}
      </button>
      {#if !auth.isConnected}
        <p class="fineprint">You'll sign in, or create a free account, first.</p>
      {/if}
    </div>

  {:else if phase === "done"}
    <div class="ok-mark" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
    </div>
    <h1 class="headline">It's in your <span class="hl-accent">passport</span>.</h1>
    <p class="sub">
      {#if info}Ticket #{editionStr} is in your account{:else}Your ticket is in your account{/if},
      and your name, photo and bio are unlocked.
    </p>
    <div class="actions">
      <button class="primary-btn" onclick={() => navigate("/tickets")}>See my passport</button>
      <button class="ghost-btn" onclick={() => navigate("/profile")}>Claim your name</button>
    </div>

  {:else if phase === "consumed"}
    {#if inThisAccount}
      <h1 class="headline">It's already in your <span class="hl-accent">passport</span>.</h1>
      <p class="sub">This ticket was added to this account, so you're all set.</p>
      <div class="actions">
        <button class="primary-btn" onclick={() => navigate("/tickets")}>See my passport</button>
      </div>
    {:else}
      <h1 class="headline">This ticket is already in a WoCo account.</h1>
      <p class="sub">
        A ticket goes into one account. If you added it with another account, sign
        in with that one. If someone forwarded you this email, ask them for a ticket
        that hasn't been added yet.
      </p>
      <div class="actions">
        {#if auth.isConnected}
          <button class="ghost-btn" onclick={() => navigate("/discover")}>Explore events</button>
        {:else}
          <button class="primary-btn" onclick={plainSignIn}>Sign in</button>
        {/if}
      </div>
    {/if}

  {:else if phase === "expired"}
    <h1 class="headline">This link has expired.</h1>
    <p class="sub">It can't add your ticket any more, but your ticket still works at the door.</p>
    <div class="actions">
      <button class="primary-btn" onclick={() => navigate("/discover")}>Explore events</button>
    </div>

  {:else}
    <h1 class="headline">{errorMsg ? "Couldn't check this link." : "This link isn't working."}</h1>
    <p class="sub">
      {errorMsg ||
        "Your email app may have cut it short. Open it again from the email, or copy the whole link into your browser."}
    </p>
    <div class="actions">
      <button class="primary-btn" onclick={() => navigate("/discover")}>Explore events</button>
    </div>
  {/if}
</div>

<style>
  .signup-root {
    max-width: 560px;
    margin: 0 auto;
    padding: 3rem 1.25rem 4rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .kicker {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 0.625rem;
    font-weight: 600;
    letter-spacing: 0.14em;
    color: var(--text-muted);
  }
  .kicker-prefix { color: var(--accent); }

  .headline {
    margin: 0;
    font-size: 2rem;
    font-weight: 800;
    line-height: 1.15;
    letter-spacing: -0.02em;
    color: var(--text);
  }
  .hl-accent { color: var(--accent); }

  .sub {
    margin: 0;
    font-size: 0.9375rem;
    line-height: 1.6;
    color: var(--text-secondary);
    max-width: 46ch;
  }

  .pending {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 2rem 0;
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .ticket-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1rem 1.125rem;
  }
  .tc-row { display: flex; align-items: flex-start; gap: 0.875rem; }
  .tc-pill {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    font-weight: 700;
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-radius: 999px;
    padding: 0.25rem 0.625rem;
  }
  .tc-meta { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
  .tc-title { font-size: 0.9375rem; font-weight: 700; color: var(--text); }
  .tc-line { font-size: 0.75rem; color: var(--text-secondary); }
  .tc-muted { color: var(--text-muted); }

  .actions {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    align-items: flex-start;
    margin-top: 0.25rem;
  }

  .primary-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem;
    padding: 0.75rem 1.5rem;
    font-size: 0.875rem; font-weight: 700;
    background: var(--accent); color: #000;
    border: none; border-radius: var(--radius-sm);
    cursor: pointer; transition: opacity var(--transition), transform 0.1s ease;
    letter-spacing: -0.01em;
  }
  .primary-btn:hover:not(:disabled) { opacity: 0.88; }
  .primary-btn:active:not(:disabled) { transform: scale(0.97); }
  .primary-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .ghost-btn {
    padding: 0.625rem 1.25rem;
    font-size: 0.8125rem; font-weight: 600;
    background: none; color: var(--text-secondary);
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    cursor: pointer; transition: color var(--transition), border-color var(--transition);
  }
  .ghost-btn:hover { color: var(--text); border-color: var(--text-muted); }

  .fineprint {
    margin: 0;
    font-size: 0.6875rem;
    color: var(--text-muted);
    line-height: 1.5;
  }

  .err-box {
    margin: 0;
    background: color-mix(in srgb, var(--error) 8%, transparent);
    color: var(--error);
    border: 1px solid color-mix(in srgb, var(--error) 25%, var(--border));
    border-radius: var(--radius-sm);
    padding: 0.5rem 0.75rem;
    font-size: 0.75rem; line-height: 1.4;
  }

  .ok-mark {
    width: 3rem; height: 3rem; display: grid; place-items: center;
    background: var(--accent); color: #000;
    border-radius: var(--radius-md);
  }

  .spinner {
    width: 12px; height: 12px; border-radius: 50%;
    border: 1.5px solid color-mix(in srgb, currentColor 25%, transparent);
    border-top-color: currentColor;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }
  .spinner--dark { border-color: rgba(0,0,0,0.25); border-top-color: #000; }
  @keyframes spin { to { transform: rotate(360deg); } }

  @media (max-width: 480px) {
    .headline { font-size: 1.625rem; }
    .signup-root { padding-top: 2rem; }
  }
</style>
