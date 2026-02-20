<script lang="ts">
  import type { EventFeed } from "@woco/shared";
  import { getEvent } from "../../api/events.js";
  import { navigate } from "../../router/router.svelte.js";
  import { onMount } from "svelte";

  interface Props {
    eventId: string;
  }

  let { eventId }: Props = $props();

  let event = $state<EventFeed | null>(null);
  let loading = $state(true);

  // Configurator options
  let showImage = $state(true);
  let showDescription = $state(false);
  let claimMode = $state<"wallet" | "email" | "both">("email");
  let theme = $state<"dark" | "light">("dark");
  let copied = $state(false);

  // Default API URL (user can override)
  const defaultApiUrl = "https://events-api.woco-net.com";

  const snippet = $derived(buildSnippet());

  function buildSnippet(): string {
    const attrs: string[] = [
      `\n  event-id="${eventId}"`,
      `\n  api-url="${defaultApiUrl}"`,
    ];
    attrs.push(`\n  claim-mode="${claimMode}"`);
    if (theme !== "dark") attrs.push(`\n  theme="${theme}"`);
    if (!showImage) attrs.push(`\n  show-image="false"`);
    if (!showDescription) attrs.push(`\n  show-description="false"`);

    return `<script src="${defaultApiUrl}/embed/woco-embed.js?v=5"><\/script>\n<woco-tickets${attrs.join("")}\n><\/woco-tickets>`;
  }

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(snippet);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = snippet;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    }
  }

  onMount(async () => {
    try {
      event = await getEvent(eventId);
    } catch {
      // ignore
    } finally {
      loading = false;
    }
  });
</script>

<div class="embed-setup">
  <button class="back-link" onclick={() => navigate(`/event/${eventId}`)}>
    &larr; Back to event
  </button>

  {#if loading}
    <p class="status">Loading...</p>
  {:else}
    <h1>Embed Tickets</h1>
    {#if event}
      <p class="subtitle">Configure the ticket widget for <strong>{event.title}</strong></p>
    {/if}

    <div class="config-grid">
      <!-- Display options -->
      <fieldset class="config-section">
        <legend>Display</legend>

        <label class="toggle-row">
          <span class="toggle-label">Show event image</span>
          <input type="checkbox" bind:checked={showImage} class="toggle" />
        </label>

        <label class="toggle-row">
          <span class="toggle-label">Show event description</span>
          <input type="checkbox" bind:checked={showDescription} class="toggle" />
        </label>
      </fieldset>

      <!-- Claim mode -->
      <fieldset class="config-section">
        <legend>Claim method</legend>

        <label class="radio-row">
          <input type="radio" name="claim-mode" value="email" bind:group={claimMode} />
          <div>
            <span class="radio-label">Email only</span>
            <span class="radio-desc">Users enter email — no wallet needed</span>
          </div>
        </label>

        <label class="radio-row">
          <input type="radio" name="claim-mode" value="wallet" bind:group={claimMode} />
          <div>
            <span class="radio-label">Wallet / Passkey</span>
            <span class="radio-desc">Users claim via Web3 wallet or passkey biometric</span>
          </div>
        </label>

        <label class="radio-row">
          <input type="radio" name="claim-mode" value="both" bind:group={claimMode} />
          <div>
            <span class="radio-label">All methods</span>
            <span class="radio-desc">Email, wallet, and passkey — maximum flexibility</span>
          </div>
        </label>
      </fieldset>

      <!-- Theme -->
      <fieldset class="config-section">
        <legend>Theme</legend>

        <label class="radio-row">
          <input type="radio" name="theme" value="dark" bind:group={theme} />
          <div>
            <span class="radio-label">Dark</span>
            <span class="radio-desc">Matches WoCo's dark UI</span>
          </div>
        </label>

        <label class="radio-row">
          <input type="radio" name="theme" value="light" bind:group={theme} />
          <div>
            <span class="radio-label">Light</span>
            <span class="radio-desc">For light-themed websites</span>
          </div>
        </label>
      </fieldset>
    </div>

    <!-- Code snippet -->
    <div class="snippet-section">
      <div class="snippet-header">
        <h2>Embed code</h2>
        <button class="copy-btn" onclick={copySnippet}>
          {#if copied}
            Copied!
          {:else}
            Copy
          {/if}
        </button>
      </div>
      <pre class="snippet-code"><code>{snippet}</code></pre>
      <p class="snippet-hint">
        Paste this into your website's HTML where you want the ticket widget to appear.
      </p>
    </div>
  {/if}
</div>

<style>
  .embed-setup {
    max-width: 640px;
    margin: 0 auto;
  }

  .back-link {
    color: var(--text-muted);
    font-size: 0.875rem;
    margin-bottom: 1.5rem;
    display: inline-block;
    transition: color var(--transition);
  }

  .back-link:hover {
    color: var(--accent-text);
  }

  h1 {
    font-size: 1.5rem;
    font-weight: 700;
    margin: 0 0 0.25rem;
    color: var(--text);
  }

  .subtitle {
    color: var(--text-secondary);
    font-size: 0.9375rem;
    margin: 0 0 1.75rem;
  }

  .config-grid {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    margin-bottom: 2rem;
  }

  .config-section {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1rem 1.25rem;
    margin: 0;
  }

  .config-section legend {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    padding: 0 0.375rem;
  }

  /* Toggle rows */
  .toggle-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0;
    cursor: pointer;
  }

  .toggle-row + .toggle-row {
    border-top: 1px solid var(--border);
  }

  .toggle-label {
    font-size: 0.875rem;
    color: var(--text);
  }

  .toggle {
    appearance: none;
    width: 36px;
    height: 20px;
    background: var(--border);
    border-radius: 10px;
    position: relative;
    cursor: pointer;
    transition: background var(--transition);
    flex-shrink: 0;
  }

  .toggle::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    background: var(--text);
    border-radius: 50%;
    transition: transform var(--transition);
  }

  .toggle:checked {
    background: var(--accent);
  }

  .toggle:checked::after {
    transform: translateX(16px);
    background: #fff;
  }

  /* Radio rows */
  .radio-row {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    padding: 0.5rem 0;
    cursor: pointer;
  }

  .radio-row + .radio-row {
    border-top: 1px solid var(--border);
  }

  .radio-row input[type="radio"] {
    appearance: none;
    width: 18px;
    height: 18px;
    border: 2px solid var(--border);
    border-radius: 50%;
    flex-shrink: 0;
    margin-top: 1px;
    cursor: pointer;
    position: relative;
    transition: border-color var(--transition);
    background: transparent;
    padding: 0;
  }

  .radio-row input[type="radio"]:checked {
    border-color: var(--accent);
  }

  .radio-row input[type="radio"]:checked::after {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 8px;
    height: 8px;
    background: var(--accent);
    border-radius: 50%;
  }

  .radio-label {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text);
    display: block;
  }

  .radio-desc {
    font-size: 0.75rem;
    color: var(--text-muted);
    display: block;
    margin-top: 0.0625rem;
  }

  /* Snippet */
  .snippet-section {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .snippet-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
  }

  .snippet-header h2 {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text);
  }

  .copy-btn {
    padding: 0.375rem 0.75rem;
    font-size: 0.75rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: #fff;
    transition: background var(--transition);
  }

  .copy-btn:hover {
    background: var(--accent-hover);
  }

  .snippet-code {
    margin: 0;
    padding: 1rem 1.25rem;
    background: var(--bg-input);
    overflow-x: auto;
    font-family: "JetBrains Mono", "Fira Code", monospace;
    font-size: 0.8125rem;
    line-height: 1.6;
    color: var(--accent-text);
    white-space: pre;
  }

  .snippet-hint {
    padding: 0.625rem 1rem;
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-muted);
    border-top: 1px solid var(--border);
  }

  .status {
    text-align: center;
    color: var(--text-muted);
    padding: 3rem 0;
  }
</style>
