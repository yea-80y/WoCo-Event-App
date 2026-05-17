<script lang="ts">
  import { navigate } from "../../router/router.svelte.js";

  interface Props { feature: string; }
  let { feature }: Props = $props();

  const headlines: Record<string, { before: string; tag: string; after: string }> = {
    tickets: { before: "Your tickets, in your\u00a0", tag: "pocket", after: "." },
    profile: { before: "Your scene, your\u00a0",    tag: "face",   after: "." },
  };
  const copy = headlines[feature] ?? headlines["tickets"];

  let email = $state("");
  let submitted = $state(false);
  let submitting = $state(false);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (!email || submitting) return;
    submitting = true;
    try {
      await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, feature }),
      });
    } catch {
      // swallow — UX succeeds regardless of backend state
    }
    submitted = true;
    submitting = false;
  }
</script>

<div class="cs-root scanlines grain">
  <div class="cs-col">

    <p class="cs-kicker">
      <span class="cs-kicker-prefix">//</span> FEATURE IN BUILD
    </p>

    <h1 class="cs-headline">
      {copy.before}<span class="tag-display cs-tag">{copy.tag}</span>{copy.after}
    </h1>

    <p class="cs-sub">
      We want attendee accounts to be self-custodied from day one — your tickets
      and your profile, on your keys. We're finishing the client-side feed signers
      that make that possible. Until then, every ticket lands in your inbox.
    </p>

    {#if import.meta.env.VITE_WAITLIST_ENABLED}
      {#if submitted}
        <p class="cs-success">
          <span class="cs-success-prefix">//</span> You're on the list.
        </p>
      {:else}
        <form class="cs-form" onsubmit={handleSubmit}>
          <input
            class="cs-input"
            type="email"
            placeholder="your@email.com"
            bind:value={email}
            required
            aria-label="Email address"
          />
          <button class="cs-btn" type="submit" disabled={submitting}>
            {submitting ? "..." : "Get notified\u00a0→"}
          </button>
        </form>
      {/if}
    {/if}

    <button class="cs-back" onclick={() => navigate("/discover")}>
      ← Browse events
    </button>
  </div>

  <div class="cs-stamp" aria-hidden="true">BUILD // 2026-05</div>
</div>

<style>
  .cs-root {
    position: relative;
    min-height: 60vh;
    padding: 4rem 1.25rem 5rem;
    overflow: hidden;
  }

  .cs-col {
    max-width: 560px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .cs-kicker {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 400;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }
  .cs-kicker-prefix {
    color: var(--text-dim);
  }

  .cs-headline {
    margin: 0;
    font-family: var(--font-display);
    font-size: clamp(2rem, 5vw, 3rem);
    font-weight: 700;
    letter-spacing: -0.03em;
    line-height: 1.1;
    color: var(--text);
  }

  .cs-tag {
    color: var(--accent);
    /* Bungee has no italic — keep upright, the colour is the accent */
  }

  .cs-sub {
    margin: 0;
    font-size: 1rem;
    line-height: 1.65;
    color: var(--text-secondary);
    max-width: 68ch;
  }

  .cs-form {
    display: flex;
    gap: 0;
    align-items: stretch;
    max-width: 420px;
  }

  .cs-input {
    flex: 1;
    min-width: 0;
    padding: 0.5625rem 0.75rem;
    font-family: var(--font-body);
    font-size: 0.875rem;
    color: var(--text);
    background: var(--bg-input, var(--bg-surface));
    border: 1px solid var(--border);
    border-right: none;
    border-radius: var(--radius-sm) 0 0 var(--radius-sm);
    outline: none;
    transition: border-color var(--transition);
  }
  .cs-input:focus { border-color: var(--accent); }
  .cs-input::placeholder { color: var(--text-dim); }

  .cs-btn {
    padding: 0.5625rem 1rem;
    font-family: var(--font-body);
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    white-space: nowrap;
    transition: border-color var(--transition), color var(--transition);
    cursor: pointer;
  }
  .cs-btn:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .cs-btn:disabled { opacity: 0.5; cursor: default; }

  @media (max-width: 480px) {
    .cs-form { flex-direction: column; }
    .cs-input {
      border-right: 1px solid var(--border);
      border-bottom: none;
      border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    }
    .cs-btn { border-radius: 0 0 var(--radius-sm) var(--radius-sm); }
  }

  .cs-success {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .cs-success-prefix { color: var(--text-dim); margin-right: 0.375rem; }

  .cs-back {
    display: inline-flex;
    align-items: center;
    background: none;
    border: none;
    padding: 0;
    font-size: 0.875rem;
    color: var(--text-muted);
    cursor: pointer;
    transition: color var(--transition);
    align-self: flex-start;
  }
  .cs-back:hover { color: var(--text); }

  .cs-stamp {
    display: none;
    position: absolute;
    bottom: 1.5rem;
    right: 1.5rem;
    font-family: var(--font-mono);
    font-size: 0.625rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-dim);
    pointer-events: none;
    user-select: none;
  }

  @media (min-width: 640px) {
    .cs-stamp { display: block; }
    .cs-root { padding-top: 4rem; }
  }
</style>
