<!--
  InviteSheet — the member's invite as a code someone can scan off their phone,
  plus Share and Copy. Opened from the tab bar's Invite key or Home.

  The link carries the member's PROFILE name once the chain confirms it, and
  their address otherwise; the address is never printed on screen, only the
  name. Loaded on first open together with the QR library, so neither touches
  the boot chunk.
-->
<script lang="ts">
  import type { Hex0x } from "@woco/shared";
  import { onMount } from "svelte";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { inviteSheet } from "../../campaign/invite-sheet.svelte.js";
  import { referralLink } from "../../api/campaign.js";
  import { verifiedProfileName } from "../../sub-ens/profile-name.js";

  let label = $state<string | null>(null);
  let codeSvg = $state<string | null>(null);
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let closeButton = $state<HTMLButtonElement | null>(null);

  const link = $derived(
    label
      ? referralLink(label)
      : auth.parent
        ? referralLink(auth.parent.toLowerCase() as Hex0x)
        : null,
  );

  onMount(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton?.focus();
    // Public reads only, so the name shows on any device and opening the sheet
    // never prompts. Until it lands, and if it never does, the address link stands.
    if (auth.parent) void verifiedProfileName(auth.parent).then((name) => { label = name; });
    return () => {
      clearTimeout(copyTimer);
      returnFocus?.focus();
    };
  });

  $effect(() => {
    const target = link;
    if (!target) return;
    let current = true;
    import("uqr")
      .then(({ renderSVG }) => {
        if (!current) return;
        // Modules take the pass's ink through currentColor; the four-module
        // border is the quiet zone scanners need around a code.
        codeSvg = renderSVG(target, {
          ecc: "M",
          border: 4,
          blackColor: "currentColor",
          whiteColor: "transparent",
        });
      })
      .catch(() => { if (current) codeSvg = null; });
    return () => { current = false; };
  });

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 2000);
    } catch {
      // Clipboard refused — Share still works where the browser has it.
    }
  }

  async function share() {
    if (!link) return;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "Host your events on WoCo", url: link });
      } catch {
        // Dismissed.
      }
      return;
    }
    await copy();
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === "Escape") inviteSheet.hide(); }} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="scrim" role="presentation" onclick={() => inviteSheet.hide()}></div>
<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="invite-sheet-title">
  <header class="head">
    <h2 id="invite-sheet-title">Your invite</h2>
    <button class="btn btn--text" bind:this={closeButton} onclick={() => inviteSheet.hide()}>Close</button>
  </header>

  <div class="pass">
    {#if codeSvg}
      <div class="code" role="img" aria-label="Code for your invite link">{@html codeSvg}</div>
    {:else}
      <div class="code code--waiting" aria-hidden="true"></div>
    {/if}
    <div class="pass-foot">
      <span class="pass-mark">WOCO</span>
      <span class="pass-from">{label ? `from ${label}.woco.eth` : "Invite to host"}</span>
    </div>
  </div>

  {#if label && link}
    <p class="link">{link.replace(/^https?:\/\//, "")}</p>
  {/if}

  <div class="actions">
    <button class="btn btn--primary" onclick={share} disabled={!link}>Share</button>
    <button class="btn btn--ghost" onclick={copy} disabled={!link} aria-live="polite">
      {copied ? "Copied" : "Copy link"}
    </button>
  </div>

  <ol class="steps">
    <li>They scan this or open your link.</li>
    <li>They verify with Stripe to start hosting.</li>
    <li>You earn a share of the platform fee on their ticket sales.</li>
  </ol>
  <p class="note">
    {label
      ? "Uses your name, so the code stays simple to scan."
      : "Claim a name and your invite shows it, and this code gets simpler to scan."}
  </p>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 150;
    background: color-mix(in srgb, var(--bg) 72%, transparent);
    animation: fade 0.15s ease;
  }
  .sheet {
    position: fixed;
    z-index: 151;
    left: 50%;
    bottom: 0;
    width: min(34rem, 100%);
    max-height: 92vh;
    overflow-y: auto;
    padding: 1rem 1.25rem calc(1.5rem + env(safe-area-inset-bottom));
    background: var(--bg-surface);
    border: 1px solid var(--border-hover);
    border-bottom: none;
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    transform: translateX(-50%);
    animation: rise 0.24s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes rise {
    from { opacity: 0; transform: translate(-50%, 1.5rem); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }

  .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.875rem; }
  .head h2 { margin: 0; font-size: 1.25rem; line-height: 1.2; letter-spacing: -0.02em; }

  /* The pass is the one light surface in the member app: bone paper, ink code. */
  .pass {
    display: grid;
    justify-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
    padding: 0.75rem;
    background: var(--text);
    color: var(--accent-ink);
    border-radius: var(--radius-md);
  }
  .code { width: min(15rem, 100%); aspect-ratio: 1; }
  .code :global(svg) { display: block; width: 100%; height: 100%; }
  .code--waiting { background: color-mix(in srgb, var(--accent-ink) 6%, transparent); }
  .pass-foot {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    width: min(15rem, 100%);
    padding-top: 0.5rem;
    border-top: 1.5px solid var(--accent-ink);
  }
  .pass-mark { font-family: var(--font-mono); font-size: 0.9375rem; font-weight: 700; letter-spacing: -0.02em; }
  .pass-from {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.78125rem;
    font-weight: 600;
    opacity: 0.75;
  }

  .link {
    margin: 0 0 0.75rem;
    padding: 0.625rem 0.75rem;
    font-family: var(--font-mono);
    font-size: 0.78125rem;
    color: var(--text-secondary);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow-wrap: anywhere;
    user-select: all;
  }

  .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }

  .steps { list-style: none; margin: 1.25rem 0 0; padding: 0; display: grid; gap: 0.5rem; counter-reset: step; }
  .steps li {
    counter-increment: step;
    display: grid;
    grid-template-columns: 1.25rem minmax(0, 1fr);
    gap: 0.5rem;
    font-size: 0.84375rem;
    color: var(--text-secondary);
  }
  .steps li::before {
    content: counter(step);
    padding-top: 0.0625rem;
    font-family: var(--font-mono);
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--accent-text);
  }
  .note { margin: 0.875rem 0 0; font-size: 0.78125rem; color: var(--text-muted); }
</style>
