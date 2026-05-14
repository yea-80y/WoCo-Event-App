<script lang="ts" module>
  export interface ImportTier {
    name: string;
    price?: string;
    currency?: string;
    saleStart?: string;
    saleEnd?: string;
    status?: string;
  }
  export interface ImportPreview {
    name: string;
    description: string;
    /** Best-effort ISO datetime-local ("YYYY-MM-DDTHH:mm") or date ("YYYY-MM-DD") */
    startDate: string;
    location: string;
    imageUrl: string;
    /** Subtitle / event sub-heading distinct from the long description */
    tagline?: string;
    /** Parsed ticket tiers (Skiddle / Eventbrite offers[]). Empty when none found. */
    tiers?: ImportTier[];
  }
</script>

<script lang="ts">
  import { authPost } from "../../api/client.js";

  interface Props {
    /** Label for the apply button in the preview card. */
    applyLabel?: string;
    /** Called with the preview when the user clicks apply. */
    onapply: (preview: ImportPreview) => void;
  }

  let { applyLabel = "✓ Fill form with these details", onapply }: Props = $props();

  let importUrl = $state("");
  let importState = $state<"idle" | "loading" | "done" | "error">("idle");
  let importError = $state("");
  let importPreview = $state<ImportPreview | null>(null);

  async function runImport() {
    const url = importUrl.trim();
    if (!url) return;
    importState = "loading";
    importError = "";
    importPreview = null;
    try {
      const res = await authPost<Partial<ImportPreview> & { endDate?: string; startTime?: string }>(
        "/api/events/import-url",
        { url },
      );
      if (!res.ok || !res.data) {
        importError = (res as { ok: false; error?: string }).error ?? "Import failed";
        importState = "error";
        return;
      }
      const d = res.data;
      // Server may return startDate (date-only) and startTime separately — combine for datetime-local.
      const combined =
        d.startDate && d.startTime && !d.startDate.includes("T")
          ? `${d.startDate}T${d.startTime.slice(0, 5)}`
          : d.startDate ?? "";
      importPreview = {
        name:        d.name        ?? "",
        description: d.description ?? "",
        startDate:   combined,
        location:    d.location    ?? "",
        imageUrl:    d.imageUrl    ?? "",
        tagline:     d.tagline,
        tiers:       Array.isArray(d.tiers) ? d.tiers : undefined,
      };
      importState = "done";
    } catch (err) {
      importError = err instanceof Error ? err.message : "Could not reach the server";
      importState = "error";
    }
  }

  function handleApply() {
    if (!importPreview) return;
    onapply(importPreview);
    reset();
  }

  function reset() {
    importState = "idle";
    importUrl = "";
    importPreview = null;
  }
</script>

<div class="import-panel">
  <div class="import-panel-header">
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 1a6 6 0 1 1 0 12A6 6 0 0 1 7 1z" stroke="currentColor" stroke-width="1.4" fill="none" opacity=".5"/>
      <path d="M5 7l2 2 4-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" opacity=".7"/>
    </svg>
    <span>Already listed on Skiddle, Fatsoma, Eventbrite?</span>
  </div>

  <div class="import-row">
    <input
      class="import-input"
      type="url"
      placeholder="Paste event URL to auto-fill the form…"
      bind:value={importUrl}
      onkeydown={(e) => { if (e.key === "Enter") runImport(); }}
      disabled={importState === "loading"}
    />
    <button
      class="import-btn"
      onclick={runImport}
      disabled={importState === "loading" || !importUrl.trim()}
    >
      {importState === "loading" ? "Fetching…" : "Import"}
    </button>
  </div>

  {#if importState === "error"}
    <p class="import-error">⚠ {importError}</p>
  {/if}

  {#if importState === "done" && importPreview}
    <div class="import-preview">
      {#if importPreview.imageUrl}
        <img class="import-thumb" src={importPreview.imageUrl} alt="" />
      {/if}
      <div class="import-preview-body">
        <strong class="import-preview-name">{importPreview.name || "(no title found)"}</strong>
        {#if importPreview.tagline}<span class="import-tagline">{importPreview.tagline}</span>{/if}
        {#if importPreview.startDate}<span class="import-meta">📅 {importPreview.startDate}</span>{/if}
        {#if importPreview.location}<span class="import-meta">📍 {importPreview.location}</span>{/if}
        {#if importPreview.tiers && importPreview.tiers.length > 0}
          <span class="import-meta">🎟 {importPreview.tiers.length} ticket tier{importPreview.tiers.length > 1 ? "s" : ""} found</span>
        {/if}
        {#if importPreview.description}
          <p class="import-preview-desc">{importPreview.description.slice(0, 180)}{importPreview.description.length > 180 ? "…" : ""}</p>
        {/if}
      </div>
      <div class="import-actions">
        <button class="import-apply-btn" onclick={handleApply}>{applyLabel}</button>
        <button class="import-dismiss-btn" onclick={reset}>Discard</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .import-panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.875rem 1rem;
    background: color-mix(in srgb, var(--accent) 5%, var(--bg-surface));
    border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
    border-radius: var(--radius-md);
  }
  .import-panel-header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .import-panel-header svg { flex-shrink: 0; color: var(--accent); }
  .import-row { display: flex; gap: 0.5rem; }
  .import-input {
    flex: 1;
    padding: 0.5rem 0.75rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 0.875rem;
    font-family: inherit;
    min-width: 0;
  }
  .import-input:focus { outline: none; border-color: var(--accent); }
  .import-input:disabled { opacity: 0.6; }
  .import-btn {
    padding: 0.5rem 1rem;
    background: var(--accent);
    color: var(--accent-ink, #fff);
    font-size: 0.875rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .import-btn:hover:not(:disabled) { background: var(--accent-hover); }
  .import-btn:disabled { opacity: 0.5; }
  .import-error { font-size: 0.8125rem; color: #ef4444; margin: 0; }
  .import-preview {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.875rem;
    background: color-mix(in srgb, #22c55e 5%, var(--bg-elevated));
    border: 1px solid color-mix(in srgb, #22c55e 25%, transparent);
    border-radius: var(--radius-sm);
  }
  .import-thumb {
    width: 100%;
    height: 120px;
    object-fit: cover;
    border-radius: 4px;
    display: block;
  }
  .import-preview-body { display: flex; flex-direction: column; gap: 0.25rem; }
  .import-preview-name { font-size: 0.9375rem; font-weight: 700; color: var(--text); }
  .import-tagline { font-size: 0.8125rem; color: var(--text-secondary); font-weight: 500; }
  .import-meta { font-size: 0.8125rem; color: var(--text-muted); }
  .import-preview-desc {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    line-height: 1.5;
    margin: 0.25rem 0 0;
  }
  .import-actions { display: flex; gap: 0.625rem; flex-wrap: wrap; }
  .import-apply-btn {
    padding: 0.5rem 1rem;
    background: #22c55e;
    color: #fff;
    font-size: 0.875rem;
    font-weight: 700;
    border-radius: var(--radius-sm);
  }
  .import-apply-btn:hover { background: #16a34a; }
  .import-dismiss-btn {
    font-size: 0.8125rem;
    color: var(--text-muted);
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
  }
  .import-dismiss-btn:hover { color: var(--text); }
</style>
