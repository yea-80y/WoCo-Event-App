<!--
  ReferralShareCard — the user's referral link, on their own profile.

  The link carries the sharer's PROFILE name once the chain confirms it
  (`#/ref/theirvenue`), and their address otherwise. That is not cosmetic: the
  name is what the RECIPIENT is shown when they land, and an address link shows
  them no name at all. Never another name they own: a site or event name would
  read as that page inviting.

  The address link works from first paint and is swapped only if a name comes
  back, so a failed or slow lookup still leaves a working card. The link is
  printed only once it is a name; an address link is copied, never shown.
-->
<script lang="ts">
  import type { Hex0x } from "@woco/shared";
  import { onMount } from "svelte";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { referralLink } from "../../api/campaign.js";
  import { verifiedProfileName } from "../../sub-ens/profile-name.js";

  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let ensLabel = $state<string | null>(null);

  onMount(() => {
    if (auth.parent) void verifiedProfileName(auth.parent).then((name) => { ensLabel = name; });
  });

  const link = $derived(
    ensLabel
      ? referralLink(ensLabel)
      : auth.parent
        ? referralLink(auth.parent.toLowerCase() as Hex0x)
        : null,
  );
  const displayLink = $derived(link?.replace(/^https?:\/\//, "") ?? "");

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 2000);
    } catch {
      // Clipboard unavailable — a name link is selectable text either way.
    }
  }
</script>

{#if link}
  <section class="refer card">
    <span class="kicker mono">REFER // EARN</span>
    <h3>Bring a venue on board</h3>
    <p>
      Know someone who runs events? When they join through your link and start selling,
      you earn a share of the platform fee on every sale, paid monthly in stablecoin once
      each event has taken place and the organiser has been paid.
    </p>
    <div class="link-row">
      {#if ensLabel}<span class="link mono" title={link}>{displayLink}</span>{/if}
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
    min-height: 2.125rem;
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
