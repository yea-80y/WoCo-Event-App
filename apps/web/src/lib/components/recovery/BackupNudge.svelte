<script lang="ts">
  /**
   * Gentle post-publish nudge — shown once an organiser's event site goes live,
   * the moment "secure access to your dashboard" is most concrete. Never a modal,
   * never a gate (owner decision, [[project_recovery_ux_rollout]]): dismissible,
   * snoozes ~7d via localStorage, and hides itself entirely once a backup exists.
   */
  import { auth } from "../../auth/auth-store.svelte.js";
  import { navigate } from "../../router/router.svelte.js";

  const SNOOZE_KEY = "woco:backup:snoozed-until";
  const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

  let visible = $state(false);
  let checked = false;

  const canProtect = $derived(auth.kind === "passkey" || auth.kind === "web3auth");

  $effect(() => {
    if (checked) return;
    if (!auth.isConnected || !canProtect) return;
    checked = true;
    const snoozedUntil = Number(localStorage.getItem(SNOOZE_KEY) ?? 0);
    if (Date.now() < snoozedUntil) return;
    auth.getBackupInventory()
      .then((entries) => { if (entries.length === 0) visible = true; })
      .catch(() => {});
  });

  function dismiss() {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
    visible = false;
  }

  function protectNow() {
    navigate("/protect");
  }
</script>

{#if visible}
  <div class="nudge" role="note">
    <button class="nudge-close" onclick={dismiss} aria-label="Dismiss">
      <svg viewBox="0 0 12 12" width="11" height="11" fill="none" aria-hidden="true">
        <path d="M1.5 1.5 L10.5 10.5 M10.5 1.5 L1.5 10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </button>

    <div class="nudge-icon" aria-hidden="true">
      <svg viewBox="0 0 32 36" fill="none">
        <path class="ni-shield" d="M16 2 L29 7 V17.5 C29 26 23.5 32 16 34.5 C8.5 32 3 26 3 17.5 V7 Z" />
        <path class="ni-key" d="M16 12 a3.5 3.5 0 1 0 0.01 0 M16 15.4 V24 M16 20.5 H19.5" />
      </svg>
    </div>

    <div class="nudge-body">
      <p class="nudge-title">Your site is live — is your dashboard backed up?</p>
      <p class="nudge-copy">
        Add a backup so you can always get back into this event's dashboard, orders,
        and payouts — on any device.
      </p>
    </div>

    <div class="nudge-actions">
      <button class="nudge-cta" onclick={protectNow}>
        Add a backup
        <svg viewBox="0 0 12 10" width="11" height="9" fill="none" aria-hidden="true">
          <path d="M1 5 H11 M7 1 L11 5 L7 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <button class="nudge-later" onclick={dismiss}>Remind me later</button>
    </div>
  </div>
{/if}

<style>
  .nudge {
    position: relative;
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 1rem;
    padding: 1.1rem 2.5rem 1.1rem 1.1rem;
    border: 1px solid var(--border-hover);
    border-radius: var(--radius-md);
    background:
      radial-gradient(160% 140% at 0% 0%, var(--accent-subtle), transparent 55%),
      var(--bg-surface);
    overflow: hidden;
    animation: nudge-rise 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  .nudge::before {
    content: "";
    position: absolute; inset: 0 0 auto 0; height: 1px;
    background: linear-gradient(90deg, var(--accent), transparent 65%);
    opacity: 0.6;
  }
  @media (max-width: 640px) {
    .nudge { grid-template-columns: auto 1fr; }
  }

  .nudge-close {
    position: absolute; top: 0.7rem; right: 0.7rem;
    display: grid; place-items: center;
    width: 1.5rem; height: 1.5rem;
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    transition: color var(--transition), background var(--transition);
  }
  .nudge-close:hover { color: var(--text); background: var(--bg-surface-hover); }

  .nudge-icon {
    display: grid; place-items: center;
    width: 2.75rem; height: 2.75rem; flex-shrink: 0;
  }
  .nudge-icon svg { width: 28px; height: 32px; overflow: visible; }
  .ni-shield { fill: var(--accent-subtle); stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; }
  .ni-key { fill: none; stroke: var(--accent); stroke-width: 2.25; stroke-linecap: round; }

  .nudge-body { min-width: 0; }
  .nudge-title {
    margin: 0 0 0.2rem;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.005em;
  }
  .nudge-copy {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-muted);
    line-height: 1.5;
    max-width: 34rem;
  }

  .nudge-actions {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.4rem;
    flex-shrink: 0;
  }
  @media (max-width: 640px) {
    .nudge-actions { grid-column: 1 / -1; align-items: stretch; flex-direction: row-reverse; justify-content: flex-start; margin-top: 0.25rem; }
  }

  .nudge-cta {
    display: inline-flex; align-items: center; gap: 0.4rem;
    padding: 0.5rem 0.9rem;
    font-size: 0.8125rem; font-weight: 600;
    color: var(--accent-ink);
    background: var(--accent);
    border-radius: var(--radius-sm);
    white-space: nowrap;
    transition: background var(--transition), transform var(--transition-fast);
  }
  .nudge-cta:hover { background: var(--accent-hover); transform: translateY(-1px); }
  .nudge-cta:active { transform: translateY(0); }
  .nudge-cta svg { transition: transform var(--transition-fast); }
  .nudge-cta:hover svg { transform: translateX(2px); }

  .nudge-later {
    font-size: 0.75rem;
    color: var(--text-muted);
    text-decoration: underline;
    text-underline-offset: 2px;
    white-space: nowrap;
  }
  .nudge-later:hover { color: var(--text-secondary); }

  @keyframes nudge-rise {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .nudge { animation: none; }
  }
</style>
