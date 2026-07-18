<script lang="ts">
  import type { SendingDomainInfo } from "@woco/shared";
  import { onMount } from "svelte";
  import {
    getSendingDomain,
    createSendingDomain,
    verifySendingDomain,
    removeSendingDomain,
  } from "../../api/marketing.js";

  let info = $state<SendingDomainInfo | null>(null);
  let loading = $state(true);
  let working = $state(false);
  let error = $state<string | null>(null);

  let domainInput = $state("");
  let localPartInput = $state("news");
  let copied = $state<string | null>(null);
  let confirmingRemove = $state(false);

  onMount(async () => {
    try {
      info = await getSendingDomain();
    } catch {
      // Panel is optional — a fetch error just shows the connect form
    } finally {
      loading = false;
    }
  });

  async function connect(): Promise<void> {
    error = null;
    working = true;
    try {
      info = await createSendingDomain(domainInput.trim().toLowerCase(), localPartInput.trim().toLowerCase());
    } catch (err) {
      error = err instanceof Error ? err.message : "Could not connect that domain.";
    } finally {
      working = false;
    }
  }

  async function check(): Promise<void> {
    error = null;
    working = true;
    try {
      info = await verifySendingDomain();
    } catch (err) {
      error = err instanceof Error ? err.message : "Check failed.";
    } finally {
      working = false;
    }
  }

  async function disconnect(): Promise<void> {
    error = null;
    working = true;
    try {
      await removeSendingDomain();
      info = null;
      confirmingRemove = false;
    } catch (err) {
      error = err instanceof Error ? err.message : "Removal failed.";
    } finally {
      working = false;
    }
  }

  async function copy(value: string, key: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      copied = key;
      setTimeout(() => { if (copied === key) copied = null; }, 1600);
    } catch {
      // Clipboard unavailable — the value is selectable text
    }
  }

  const verified = $derived(info?.status === "verified");
</script>

<section class="domain" aria-label="Sending domain">
  <header class="dom-head">
    <h3>Send from your own domain</h3>
    {#if info}
      <span class="chip" class:ok={verified}>{verified ? "verified" : info.status.replace(/_/g, " ")}</span>
    {/if}
  </header>

  {#if loading}
    <p class="muted">Checking…</p>
  {:else if !info}
    <p class="muted">
      Broadcasts currently send from the WoCo address. Connect a domain you own and they'll
      come from your brand instead — your name in the inbox, your sender reputation.
    </p>
    <div class="connect-row">
      <div class="from-preview" aria-hidden="true">
        <input class="inp local" type="text" bind:value={localPartInput} maxlength="64" placeholder="news" aria-label="Address before the @" />
        <span class="at">@</span>
        <input class="inp host" type="text" bind:value={domainInput} placeholder="mail.yourvenue.com" aria-label="Your domain" />
      </div>
      <button class="btn-primary" disabled={working || !domainInput.trim()} onclick={() => void connect()}>
        {working ? "Connecting…" : "Connect domain"}
      </button>
    </div>
  {:else}
    <p class="muted">
      {#if verified}
        Marketing email sends from <strong class="mono">{info.fromAddress}</strong>.
      {:else}
        Add these records at your DNS provider, then check. Until it verifies, broadcasts
        keep sending from the WoCo address — nothing breaks in the meantime.
      {/if}
    </p>

    {#if !verified && info.records.length > 0}
      <div class="records">
        {#each info.records as r (r.name + r.type)}
          <div class="rec">
            <span class="rec-type mono">{r.type}</span>
            <div class="rec-vals">
              <button class="rec-val mono" title="Copy name" onclick={() => void copy(r.name, `n:${r.name}`)}>
                {r.name}
                <span class="copy-flash" class:show={copied === `n:${r.name}`}>copied</span>
              </button>
              <button class="rec-val mono dim" title="Copy value" onclick={() => void copy(r.value, `v:${r.name}`)}>
                {r.value}
                <span class="copy-flash" class:show={copied === `v:${r.name}`}>copied</span>
              </button>
            </div>
            {#if r.status}
              <span class="chip sm" class:ok={r.status === "verified"}>{r.status === "verified" ? "ok" : "waiting"}</span>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    <div class="dom-actions">
      {#if !verified}
        <button class="btn-primary" disabled={working} onclick={() => void check()}>
          {working ? "Checking…" : "Check DNS"}
        </button>
      {/if}
      {#if confirmingRemove}
        <button class="btn-danger" disabled={working} onclick={() => void disconnect()}>
          {working ? "Removing…" : "Yes, disconnect"}
        </button>
        <button class="btn-ghost" onclick={() => (confirmingRemove = false)}>Keep it</button>
      {:else}
        <button class="btn-ghost" onclick={() => (confirmingRemove = true)}>Disconnect</button>
      {/if}
    </div>
  {/if}

  {#if error}<p class="err">{error}</p>{/if}
</section>

<style>
  .domain {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-surface);
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  .dom-head { display: flex; align-items: center; gap: 0.625rem; }
  .dom-head h3 { font-family: var(--font-display); font-size: 1rem; margin: 0; flex: 1; }

  .chip {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--warning);
    border: 1px solid color-mix(in srgb, var(--warning) 40%, var(--border));
    border-radius: var(--radius-sm);
    padding: 0.15rem 0.45rem;
    white-space: nowrap;
  }
  .chip.ok {
    color: var(--accent-text);
    border-color: color-mix(in srgb, var(--accent) 50%, var(--border));
    background: var(--accent-subtle);
  }
  .chip.sm { font-size: 0.625rem; padding: 0.1rem 0.35rem; }

  .muted { color: var(--text-muted); font-size: 0.8125rem; line-height: 1.55; margin: 0; }
  .muted strong { color: var(--accent-text); }
  .mono { font-family: var(--font-mono); }

  .connect-row { display: flex; flex-direction: column; gap: 0.625rem; }

  .from-preview { display: flex; align-items: center; gap: 0.375rem; }

  .inp {
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text);
    padding: 0.575rem 0.625rem;
    font-size: 0.8125rem;
    font-family: var(--font-mono);
    transition: border-color var(--transition);
  }
  .inp:focus { border-color: var(--accent); outline: none; }
  .inp.local { width: 7rem; }
  .inp.host { flex: 1; min-width: 0; }
  .at { color: var(--text-muted); font-family: var(--font-mono); }

  .records {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .rec {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0.75rem;
    background: var(--bg);
  }
  .rec + .rec { border-top: 1px solid var(--border); }

  .rec-type {
    font-size: 0.6875rem;
    color: var(--accent-text);
    width: 3.5rem;
    flex: none;
  }

  .rec-vals { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.2rem; }

  .rec-val {
    position: relative;
    text-align: left;
    font-size: 0.75rem;
    color: var(--text);
    overflow-wrap: anywhere;
    padding: 0;
    cursor: copy;
  }
  .rec-val.dim { color: var(--text-muted); }
  .rec-val:hover { color: var(--accent-text); }

  .copy-flash {
    position: absolute;
    right: 0;
    top: -0.1rem;
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--accent);
    opacity: 0;
    transition: opacity var(--transition);
    pointer-events: none;
  }
  .copy-flash.show { opacity: 1; }

  .dom-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }

  .btn-primary {
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 700;
    font-size: 0.875rem;
    padding: 0.625rem 1.125rem;
    border-radius: var(--radius-md);
    transition: background var(--transition), opacity var(--transition);
  }
  .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-ghost {
    border: 1px solid var(--border);
    color: var(--text-secondary);
    font-size: 0.875rem;
    padding: 0.625rem 1.125rem;
    border-radius: var(--radius-md);
    transition: border-color var(--transition), color var(--transition);
  }
  .btn-ghost:hover { border-color: var(--border-hover); color: var(--text); }

  .btn-danger {
    background: var(--error-subtle);
    color: var(--error);
    border: 1px solid transparent;
    font-size: 0.875rem;
    font-weight: 600;
    padding: 0.625rem 1.125rem;
    border-radius: var(--radius-md);
    transition: border-color var(--transition);
  }
  .btn-danger:hover:not(:disabled) { border-color: var(--error); }

  .err { color: var(--error); font-size: 0.8125rem; margin: 0; }
</style>
