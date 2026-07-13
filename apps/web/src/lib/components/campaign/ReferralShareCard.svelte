<!--
  ReferralShareCard — the user's referral link, on their own profile.
  Deliberately zero-fetch: the link is derived from the signed-in address,
  nothing else is loaded. Earnings/history views come later with the payout
  dashboard.
-->
<script lang="ts">
  import type { Hex0x } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { referralLink } from "../../api/campaign.js";

  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  const link = $derived(auth.parent ? referralLink(auth.parent.toLowerCase() as Hex0x) : null);
  const displayLink = $derived(link?.replace(/^https?:\/\//, "") ?? "");

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 2000);
    } catch {
      // Clipboard unavailable — the link is selectable text either way.
    }
  }
</script>

{#if link}
  <section class="refer card">
    <span class="kicker mono">REFER // EARN</span>
    <h3>Bring a venue on board</h3>
    <p>
      Know someone who runs events? When they join through your link and start selling,
      you earn a share of the platform fee on every sale — recorded on-chain, paid on
      real revenue.
    </p>
    <div class="link-row">
      <span class="link mono" title={link}>{displayLink}</span>
      <button class="copy-btn" onclick={copy} aria-live="polite">
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  </section>
{/if}

<style>
  .refer {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1.125rem 1.25rem;
    margin-bottom: 1rem;
  }
  .kicker {
    font-size: 0.6875rem;
    letter-spacing: 0.14em;
    color: var(--accent-text);
  }
  .mono { font-family: var(--font-mono); }
  h3 {
    font-family: var(--font-display);
    font-size: 1rem;
    margin: 0.375rem 0 0.25rem;
    color: var(--text);
  }
  p {
    margin: 0 0 0.875rem;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    max-width: 52ch;
  }
  .link-row {
    display: flex;
    align-items: stretch;
    gap: 0.5rem;
  }
  .link {
    flex: 1;
    min-width: 0;
    font-size: 0.75rem;
    color: var(--text-secondary);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.5rem 0.625rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    user-select: all;
  }
  .copy-btn {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 0.8125rem;
    padding: 0 1rem;
    background: var(--accent);
    color: var(--accent-ink);
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background var(--transition);
    white-space: nowrap;
  }
  .copy-btn:hover { background: var(--accent-hover); }
  .copy-btn:active { background: var(--accent-press); }
  .copy-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
