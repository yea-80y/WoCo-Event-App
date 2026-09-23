<!--
  InviteSheet — the member's codes, each one scannable off their phone, with
  Share and Copy: Invite to host, Follow me, and one per page the account's own
  names point at. Opened from the tab bar's Invite key, Home and Contacts.

  Which codes exist and where each goes is decided in `campaign/share-codes.ts`;
  `campaign/share-inputs.ts` gathers what that needs without a prompt. A link is
  printed only when it carries a name: an address link is shown as a code, never
  as text. Loaded on first open together with the QR library, so neither touches
  the boot chunk.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { subEnsName } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { studioRole } from "../../auth/studio-role.svelte.js";
  import { inviteSheet } from "../../campaign/invite-sheet.svelte.js";
  import { shareCodes } from "../../campaign/share-codes.js";
  import { loadShareInputs, type ShareInputs } from "../../campaign/share-inputs.js";

  let inputs = $state<ShareInputs>({ profileName: null, held: [], pages: [] });
  let selected = $state<string>(inviteSheet.start);
  let codeSvg = $state<string | null>(null);
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let closeButton = $state<HTMLButtonElement | null>(null);

  const codes = $derived(auth.parent ? shareCodes({ address: auth.parent, ...inputs }) : []);
  // A page code can drop out when a fresher chain read says its name no longer
  // loads; the sheet then shows the first code rather than nothing.
  const code = $derived(codes.find((c) => c.id === selected) ?? codes[0] ?? null);

  const caption = $derived.by(() => {
    if (!code) return "";
    if (code.kind === "page") return code.name ? subEnsName(code.name) : code.title;
    const name = inputs.profileName;
    if (code.kind === "follow") return name ? subEnsName(name) : "Follow me";
    return name ? `from ${subEnsName(name)}` : "Invite to host";
  });

  onMount(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton?.focus();
    let live = true;
    // Public reads, plus the organiser's own site list only when a session is
    // already on this device, so opening the sheet never prompts. Until the reads
    // land, and if they never do, the address codes stand.
    if (auth.parent) {
      void loadShareInputs(
        auth.parent,
        { organiser: studioRole.isOrganiser, hasSession: auth.hasSession },
        (next) => { if (live) inputs = next; },
      );
    }
    return () => {
      live = false;
      clearTimeout(copyTimer);
      returnFocus?.focus();
    };
  });

  $effect(() => {
    const target = code?.link;
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

  function choose(id: string) {
    selected = id;
    copied = false;
  }

  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.link);
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 2000);
    } catch {
      // Clipboard refused — Share still works where the browser has it.
    }
  }

  async function share() {
    if (!code) return;
    if (typeof navigator.share === "function") {
      const title =
        code.kind === "invite" ? "Host your events on WoCo" : code.kind === "follow" ? "Follow me on WoCo" : code.title;
      try {
        await navigator.share({ title, url: code.link });
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
    <h2 id="invite-sheet-title">Your codes</h2>
    <button class="btn btn--text" bind:this={closeButton} onclick={() => inviteSheet.hide()}>Close</button>
  </header>

  {#if codes.length > 1}
    <div class="choices" role="radiogroup" aria-label="Which code">
      {#each codes as c (c.id)}
        <button class="choice" role="radio" aria-checked={c.id === code?.id} onclick={() => choose(c.id)}>
          {c.title}
        </button>
      {/each}
    </div>
  {/if}

  <div class="pass">
    {#if codeSvg}
      <div class="code" role="img" aria-label="Code for {code?.title ?? 'your link'}">{@html codeSvg}</div>
    {:else}
      <div class="code code--waiting" aria-hidden="true"></div>
    {/if}
    <div class="pass-foot">
      <span class="pass-mark">WOCO</span>
      <span class="pass-from">{caption}</span>
    </div>
  </div>

  {#if code?.name}
    <p class="link">{code.link.replace(/^https?:\/\//, "")}</p>
  {/if}

  <div class="actions">
    <button class="btn btn--primary" onclick={share} disabled={!code}>Share</button>
    <button class="btn btn--ghost" onclick={copy} disabled={!code} aria-live="polite">
      {copied ? "Copied" : "Copy link"}
    </button>
  </div>

  {#if code?.kind === "invite"}
    <ol class="steps">
      <li>They scan this or open your link.</li>
      <li>They verify with Stripe to start hosting.</li>
      <li>They confirm you invited them.</li>
      <li>You earn a share of the platform fee on their ticket sales.</li>
    </ol>
  {:else if code?.kind === "follow"}
    <ol class="steps">
      <li>They scan this or open your link.</li>
      <li>Your profile opens, with a Follow button.</li>
      <li>You show up under Following in their Contacts.</li>
    </ol>
  {/if}

  {#if code?.kind === "page"}
    <p class="note">Opens {code.title} at its own web address.</p>
  {:else if code?.name}
    <p class="note">Uses your name, so the code stays simple to scan.</p>
  {:else if code && !inputs.profileName}
    <p class="note">Claim a name and your codes show it, and get simpler to scan.</p>
  {/if}
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

  /* One row that scrolls sideways, so an organiser with many pages never pushes the code down. */
  .choices {
    display: flex;
    gap: 0.375rem;
    margin: 0 -1.25rem 0.875rem;
    padding: 0 1.25rem;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .choices::-webkit-scrollbar { display: none; }
  .choice {
    flex: none;
    max-width: 14rem;
    padding: 0.4375rem 0.75rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-secondary);
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    transition: color var(--transition), border-color var(--transition), background var(--transition);
  }
  .choice:hover { color: var(--text); border-color: var(--border-hover); }
  /* The chosen code wears the pass's bone paper, tying the choice to the code below it. */
  .choice[aria-checked="true"] { color: var(--accent-ink); background: var(--text); border-color: var(--text); }

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
