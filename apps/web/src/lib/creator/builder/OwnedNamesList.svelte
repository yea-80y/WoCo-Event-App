<script lang="ts">
  import type { OwnedSubEnsName } from "../../api/sub-ens.js";

  type LoadState = "loading" | "ready" | "empty" | "error";

  interface Props {
    state: LoadState;
    names: OwnedSubEnsName[];
    /** Selection — omit `onselect` for a read-only list (e.g. dashboard). */
    selected?: string;
    onselect?: (label: string) => void;
    onretry?: () => void;
    /** Copy shown when the user owns no names. */
    emptyText?: string;
  }

  let { state, names, selected = "", onselect, onretry, emptyText }: Props = $props();
  let selectable = $derived(typeof onselect === "function");
</script>

{#if state === "loading"}
  <div class="loading"><span class="spinner"></span><span class="muted-sm">Loading your names…</span></div>
{:else if state === "error"}
  <p class="msg msg--warn">Couldn't load your names.{#if onretry} <button class="link-btn" onclick={onretry}>Retry</button>{/if}</p>
{:else if state === "empty"}
  <p class="muted-sm">{emptyText ?? "You don't own any .woco.eth names yet."}</p>
{:else if state === "ready"}
  <div class="name-list">
    {#each names as n (n.label)}
      <div class="name-row" class:name-row--active={selectable && selected === n.label} class:name-row--static={!selectable}>
        {#if selectable}
          <button type="button" class="name-select" onclick={() => onselect!(n.label)}>
            <span class="name-mark" aria-hidden="true"></span>
            <span class="name-text">
              <span class="name-ens">{n.ensName}</span>
              <span class="name-status">{n.previewUrl ? "points at a site" : "not pointed anywhere yet"}</span>
            </span>
          </button>
        {:else}
          <span class="name-select name-select--static">
            <span class="name-text">
              <span class="name-ens">{n.ensName}</span>
              <span class="name-status">{n.previewUrl ? "points at a site" : "not pointed anywhere yet"}</span>
            </span>
          </span>
        {/if}
        {#if n.previewUrl}
          <a class="preview-link" href={n.previewUrl} target="_blank" rel="noopener" title="Preview current content">
            Preview
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M3 1h6v6M9 1L3.5 6.5M4 2H1v7h7V6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </a>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .muted-sm { font-size: 0.8125rem; color: var(--text-muted); line-height: 1.5; margin: 0; }
  .loading { display: flex; align-items: center; gap: 0.625rem; }

  .name-list { display: flex; flex-direction: column; gap: 0.4rem; }
  .name-row {
    display: flex; align-items: center; gap: 0.5rem;
    background: var(--bg-elevated); border: 1.5px solid var(--border);
    border-radius: 6px; transition: border-color 130ms, background 130ms; overflow: hidden;
  }
  .name-row:not(.name-row--static):hover { border-color: color-mix(in srgb, #C7F23A 40%, var(--border)); }
  .name-row--active { border-color: #C7F23A; background: color-mix(in srgb, #C7F23A 6%, var(--bg)); }

  .name-select {
    flex: 1; min-width: 0; display: flex; align-items: center; gap: 0.5rem;
    padding: 0.5rem 0.625rem; cursor: pointer; text-align: left; background: none; border: none;
  }
  .name-select--static { cursor: default; }
  .name-mark { width: 13px; height: 13px; border-radius: 50%; border: 1.5px solid var(--border); position: relative; flex-shrink: 0; transition: border-color 130ms; }
  .name-row--active .name-mark { border-color: #C7F23A; }
  .name-row--active .name-mark::after { content: ""; position: absolute; inset: 2.5px; border-radius: 50%; background: #C7F23A; }

  .name-text { display: flex; flex-direction: column; gap: 0.05rem; min-width: 0; }
  .name-ens { font-family: monospace; font-size: 0.8125rem; font-weight: 700; color: var(--text); letter-spacing: -0.01em; }
  .name-status { font-size: 0.6875rem; color: var(--text-muted); }

  .preview-link {
    display: inline-flex; align-items: center; gap: 0.25rem; flex-shrink: 0;
    margin-right: 0.5rem; padding: 0.3rem 0.5rem; font-size: 0.6875rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.04em; text-decoration: none;
    color: var(--text-muted); border: 1px solid var(--border); border-radius: 4px; transition: all 120ms;
  }
  .preview-link:hover { color: #C7F23A; border-color: color-mix(in srgb, #C7F23A 45%, var(--border)); }

  .msg { margin: 0; display: flex; align-items: center; gap: 0.375rem; font-size: 0.8125rem; line-height: 1.4; }
  .msg--warn { color: #f59e0b; }
  .link-btn { color: #C7F23A; text-decoration: underline; cursor: pointer; background: none; border: none; padding: 0; font: inherit; }

  .spinner {
    display: inline-block; width: 13px; height: 13px;
    border: 1.5px solid color-mix(in srgb, #C7F23A 30%, var(--border));
    border-top-color: #C7F23A; border-radius: 50%; animation: spin 0.55s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
