<script lang="ts">
  import { onMount } from "svelte";
  import { router } from "../router/router.svelte.js";
  import { loginRequest } from "../auth/login-request.svelte.js";
  import { signingRequest } from "../auth/signing-request.svelte.js";
  import { accountSetupRequest } from "../auth/account-setup-request.svelte.js";
  import { gate } from "../attendee/gate/gate.svelte.js";
  import { detectInAppBrowser } from "../browser/in-app-browser.js";
  import {
    consumeInstallPrompt,
    deferredInstallPrompt,
    installedThisSession,
    isStandalone,
    onInstallStateChange,
  } from "./install-capture.js";
  import { decideInstallOffer, readInstallMemory, writeInstallMemory, type InstallMemory } from "./install-offer.js";

  /**
   * "Install WoCo" on the home screens (stage 2 of the home-screen app). Lazy:
   * AttendeeApp loads this only on a home route outside the installed app, and
   * the decision itself lives in install-offer.ts where it is tested.
   */

  function storage(): Storage | undefined {
    try {
      return window.localStorage;
    } catch {
      return undefined;
    }
  }

  let hasPrompt = $state(deferredInstallPrompt() !== null);
  let memory = $state<InstallMemory>(readInstallMemory(storage()));
  let working = $state(false);

  const ua = navigator.userAgent;
  const touchMac = navigator.maxTouchPoints > 1;
  const inAppBrowser =
    detectInAppBrowser(ua, {
      telegramProxy: "TelegramWebviewProxy" in window,
      publicKeyCredential: "PublicKeyCredential" in window,
      touchMac,
    }) !== null;

  onMount(() =>
    onInstallStateChange(() => {
      hasPrompt = deferredInstallPrompt() !== null;
      if (installedThisSession()) remember({ ...memory, installed: true });
    }),
  );

  const offer = $derived(
    decideInstallOffer({
      userAgent: ua,
      touchMac,
      standalone: isStandalone(),
      hasPrompt,
      inAppBrowser,
      route: router.route,
      busy: loginRequest.pending || signingRequest.pending !== null || accountSetupRequest.pending !== null || gate.pending,
      memory,
      now: Date.now(),
    }),
  );

  function remember(next: InstallMemory): void {
    memory = next;
    writeInstallMemory(storage(), next);
  }

  function dismiss(): void {
    remember({ ...memory, dismissedAt: Date.now() });
  }

  async function install(): Promise<void> {
    const p = consumeInstallPrompt();
    if (!p) return;
    working = true;
    try {
      await p.prompt();
      const { outcome } = await p.userChoice;
      // Said no in the browser's own dialog: the same as closing ours.
      remember(outcome === "accepted" ? { ...memory, installed: true } : { ...memory, dismissedAt: Date.now() });
    } catch {
      // The prompt could not be shown; nothing to retry until the browser offers again.
    } finally {
      working = false;
    }
  }
</script>

{#if offer}
  <aside class="install" aria-label="Install WoCo">
    <div class="text">
      <p class="title">Get WoCo on your home screen</p>
      {#if offer === "prompt"}
        <p class="body">Opens like an app - your tickets one tap away.</p>
      {:else if offer === "ios"}
        <p class="body">Tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.</p>
      {:else}
        <p class="body">Open the <strong>menu</strong> (⋮), then tap <strong>Install</strong>.</p>
      {/if}
    </div>
    <div class="actions">
      {#if offer === "prompt"}
        <button class="btn btn--primary" onclick={install} disabled={working}>Install WoCo</button>
      {/if}
      <button class="close" onclick={dismiss} aria-label="Not now">✕</button>
    </div>
  </aside>
{/if}

<style>
  .install {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 0 0 1rem;
    padding: 0.75rem 0.75rem 0.75rem 1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .title {
    margin: 0;
    color: var(--text);
    font-weight: 600;
    font-size: 0.925rem;
  }
  .body {
    margin: 0.15rem 0 0;
    color: var(--text-secondary);
    font-size: 0.85rem;
  }
  .body strong {
    color: var(--text);
    font-weight: 600;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
  }
  .close {
    width: 2.25rem;
    height: 2.25rem;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 0.9rem;
    cursor: pointer;
    border-radius: var(--radius-sm);
  }
  .close:hover {
    color: var(--text);
    background: var(--bg-surface-hover);
  }
</style>
