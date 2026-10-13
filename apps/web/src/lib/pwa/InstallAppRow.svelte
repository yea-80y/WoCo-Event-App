<script lang="ts">
  import { onMount } from "svelte";
  import { detectInAppBrowser } from "../browser/in-app-browser.js";
  import {
    announceInstallChange,
    consumeInstallPrompt,
    deferredInstallPrompt,
    installedThisSession,
    isStandalone,
    onInstallStateChange,
  } from "./install-capture.js";
  import { installMethod, readInstallMemory, showInstallCard, writeInstallMemory } from "./install-offer.js";

  /**
   * The permanent install entry, for organisers and attendees alike. `row`: the
   * "Install the app" line in Profile's Account card. `card`: the slim "Get the
   * app" card at the bottom of the home screens (see InstallCardSlot), which waits
   * while the top banner is asking. Neither can be dismissed: they go only once
   * the app is installed. Where there is no install path they show nothing.
   */
  let { variant = "row" }: { variant?: "row" | "card" } = $props();

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
  let memory = $state(readInstallMemory(storage()));
  let installed = $derived(memory.installed === true);
  let working = $state(false);
  let showSteps = $state(false);

  onMount(() =>
    onInstallStateChange(() => {
      hasPrompt = deferredInstallPrompt() !== null;
      memory = readInstallMemory(storage());
      if (installedThisSession() && !installed) markInstalled();
    }),
  );

  const inputs = $derived({ userAgent: ua, touchMac, standalone: isStandalone(), hasPrompt, inAppBrowser, installed });
  const method = $derived(installMethod(inputs));
  const visible = $derived(
    method !== null && (variant === "row" || showInstallCard({ ...inputs, memory, now: Date.now() })),
  );

  function markInstalled(): void {
    memory = { ...readInstallMemory(storage()), installed: true };
    writeInstallMemory(storage(), memory);
    announceInstallChange();
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

{#if visible && variant === "card"}
  <aside class="card" aria-label="Get the app">
    <div class="card-text">
      <p class="card-title">Get the app</p>
      {#if method === "prompt"}
        <p class="card-body">WoCo on your home screen - tickets and events one tap away.</p>
      {:else if method === "ios"}
        <p class="card-body">Tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.</p>
      {:else}
        <p class="card-body">Open the <strong>menu</strong> (⋮), then tap <strong>Install</strong>.</p>
      {/if}
    </div>
    {#if method === "prompt"}
      <button class="btn btn--primary" onclick={install} disabled={working}>Install</button>
    {/if}
  </aside>
{:else if visible}
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
  .card {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 2rem 0 1rem;
    padding: 0.75rem 0.75rem 0.75rem 1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
  }
  .card-text {
    flex: 1;
    min-width: 0;
  }
  .card-title {
    margin: 0;
    color: var(--text);
    font-weight: 600;
    font-size: 0.875rem;
  }
  .card-body {
    margin: 0.15rem 0 0;
    color: var(--text-secondary);
    font-size: 0.8125rem;
  }
  .card-body strong {
    color: var(--text);
    font-weight: 600;
  }
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
