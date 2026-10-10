<script lang="ts">
  import { onMount } from "svelte";
  import { detectInAppBrowser } from "../browser/in-app-browser.js";
  import {
    consumeInstallPrompt,
    deferredInstallPrompt,
    installedThisSession,
    isStandalone,
    onInstallStateChange,
  } from "./install-capture.js";
  import { installMethod, readInstallMemory, writeInstallMemory } from "./install-offer.js";

  /**
   * The permanent "Install the app" row in Profile's Account card, for organisers
   * and attendees alike. Unlike the banner it cannot be dismissed: it goes only
   * once the app is installed. Where there is no install path it shows nothing.
   */

  function storage(): Storage | undefined {
    try {
      return window.localStorage;
    } catch {
      return undefined;
    }
  }

  const ua = navigator.userAgent;
  const touchMac = navigator.maxTouchPoints > 1;
  const inAppBrowser =
    detectInAppBrowser(ua, {
      telegramProxy: "TelegramWebviewProxy" in window,
      publicKeyCredential: "PublicKeyCredential" in window,
      touchMac,
    }) !== null;

  let hasPrompt = $state(deferredInstallPrompt() !== null);
  let installed = $state(readInstallMemory(storage()).installed === true);
  let working = $state(false);
  let showSteps = $state(false);

  onMount(() =>
    onInstallStateChange(() => {
      hasPrompt = deferredInstallPrompt() !== null;
      if (installedThisSession()) markInstalled();
    }),
  );

  const method = $derived(installMethod({ userAgent: ua, touchMac, standalone: isStandalone(), hasPrompt, inAppBrowser, installed }));

  function markInstalled(): void {
    installed = true;
    writeInstallMemory(storage(), { ...readInstallMemory(storage()), installed: true });
  }

  async function install(): Promise<void> {
    const p = deferredInstallPrompt();
    if (!p || working) return;
    working = true;
    try {
      await p.prompt();
      if ((await p.userChoice).outcome === "accepted") markInstalled();
    } catch {
      // The prompt could not be shown; the browser may offer again later.
    } finally {
      consumeInstallPrompt();
      working = false;
    }
  }
</script>

{#if method}
  <div class="row">
    <span class="label">App</span>
    {#if method === "prompt"}
      <button class="link" onclick={install} disabled={working}>Install the app</button>
    {:else}
      <button class="link" onclick={() => (showSteps = !showSteps)} aria-expanded={showSteps}>Add to Home Screen</button>
    {/if}
  </div>
  {#if showSteps && method !== "prompt"}
    <p class="steps">
      {#if method === "ios"}
        Tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
      {:else}
        Open the <strong>menu</strong> (⋮), then tap <strong>Install</strong>.
      {/if}
    </p>
  {/if}
{/if}

<style>
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.625rem 0;
    border-bottom: 1px solid var(--border);
  }
  .label {
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--accent-text);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .link:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .steps {
    margin: 0.5rem 0 0.625rem;
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }
  .steps strong {
    color: var(--text);
    font-weight: 600;
  }
</style>
