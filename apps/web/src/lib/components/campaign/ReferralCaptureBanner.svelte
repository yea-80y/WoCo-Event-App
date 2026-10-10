<!--
  ReferralCaptureBanner (#34) — tells a visitor who followed an invite link that
  the invite registered.

  Capture is silent by design: `#/ref/{address}` stores the referrer and posts
  nothing until the visitor's first authenticated moment, so landing on a link
  never triggers a signing prompt. The cost was that nobody could tell it had
  worked — not the visitor, and not anyone testing the flow, which is how #34
  was written up as "verify by checking localStorage".

  Zero-fetch on purpose. When the sharer has a WoCo name their link carries it
  (`#/ref/theirvenue`), so the name is already in hand. Without one the banner
  names nobody: account addresses stay off screen (owner decision, 2026-09-14),
  and this component does no lookup of its own — the landing path is the wrong
  place to spend a network read.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import {
    referralNoticeFor,
    dismissReferralNotice,
    capturedRefName,
  } from "../../campaign/referral-capture.js";

  // Read once on mount rather than reactively: the value lives in localStorage,
  // and the only writers are the capture path (which lands here) and the post
  // path (which is followed by a reload-free navigation this banner should not
  // outlive — hence the re-read below when auth completes is not needed).
  let invited = $state(false);
  let inviterName = $state<string | null>(null);

  onMount(() => {
    invited = referralNoticeFor() !== null;
    const name = capturedRefName();
    inviterName = name ? `${name}.woco.eth` : null;
  });

  function dismiss() {
    dismissReferralNotice();
    invited = false;
  }
</script>

{#if invited}
  <aside class="ref-capture" role="status">
    <div class="inner">
      <span class="kicker mono">INVITED</span>
      <span class="text">
        {#if inviterName}
          You were invited by <span class="mono addr">{inviterName}</span>. Sign in
          when you're ready and they'll get the credit.
        {:else}
          You were invited to WoCo. Sign in when you're ready and whoever invited
          you gets the credit.
        {/if}
      </span>
      <button class="dismiss" onclick={dismiss} aria-label="Dismiss invite notice">Got it</button>
    </div>
  </aside>
{/if}

<style>
  .ref-capture {
    background:
      linear-gradient(
        to right,
        color-mix(in srgb, var(--accent) 14%, transparent),
        transparent 55%
      ),
      var(--bg-surface);
    border-bottom: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
  }

  .inner {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.25rem 0.625rem;
    padding: 0.5rem 1.5rem;
  }

  .kicker {
    font-size: 0.6875rem;
    letter-spacing: 0.14em;
    font-weight: 700;
    color: var(--accent-text, var(--text));
  }

  .text {
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }

  .addr {
    color: var(--text);
  }

  .dismiss {
    margin-left: auto;
    padding: 0.25rem 0.75rem;
    font-size: 0.75rem;
    font-weight: 700;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border);
    transition: color var(--transition), border-color var(--transition);
  }

  .dismiss:hover {
    color: var(--text);
    border-color: var(--text-secondary);
  }

  @media (max-width: 640px) {
    .inner {
      padding: 0.5rem 1.25rem;
    }
  }
</style>
