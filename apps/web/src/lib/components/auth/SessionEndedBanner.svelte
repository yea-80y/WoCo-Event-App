<!--
  SessionEndedBanner (#256) — app-chrome strip for a session the server has
  proven dead. Without it, every screen's authenticated reads fail and render
  as negative states ("no events", "verify with Stripe") — a recoverable state
  that reads as data loss. One strip names the real state and offers the one
  action that fixes it.

  Renders only while the store still holds an account: fully signed out,
  screens already show honest signed-out states and the header has its own
  sign-in button.

  Reload on successful re-login rather than patching state: the screens have
  already painted their negatives from the dead session and do not refetch on
  session change — a clean boot is the only path that leaves nothing stale.
-->
<script lang="ts">
  import { sessionHealth } from "../../api/session-health.svelte.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";

  const visible = $derived(sessionHealth.ended && auth.isConnected);

  function signIn() {
    void loginRequest.request().then((ok) => {
      if (ok) globalThis.location?.reload();
    });
  }
</script>

{#if visible}
  <aside class="session-ended" role="alert">
    <div class="inner">
      <span class="kicker kicker--hi">SESSION ENDED</span>
      <span class="text">
        Your session ended, so your data can't be shown right now — it is not lost.
      </span>
      <button class="sign-in" onclick={signIn}>Sign in again</button>
    </div>
  </aside>
{/if}

<style>
  .session-ended {
    background:
      linear-gradient(
        to right,
        color-mix(in srgb, var(--warning, #f59e0b) 12%, transparent),
        transparent 55%
      ),
      var(--bg-surface);
    border-bottom: 1px solid color-mix(in srgb, var(--warning, #f59e0b) 35%, var(--border));
  }

  .inner {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.25rem 0.625rem;
    padding: 0.5rem 1.5rem;
  }

  .text {
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }

  .sign-in {
    margin-left: auto;
    padding: 0.25rem 0.75rem;
    font-size: 0.75rem;
    font-weight: 700;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: var(--accent-ink);
    border: 1px solid var(--accent);
    transition: background var(--transition);
  }

  .sign-in:hover {
    background: var(--accent-hover);
  }

  @media (max-width: 640px) {
    .inner {
      padding: 0.5rem 1.25rem;
    }
  }
</style>
