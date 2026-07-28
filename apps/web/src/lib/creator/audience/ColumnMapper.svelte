<script lang="ts">
  /**
   * Step 2 of the CSV import: assign a role to each column in the organiser's file.
   *
   * Presents THEIR columns as the objects, not our fields. An organiser recognises
   * "Postcode / M1 1AA" instantly; they do not recognise our schema. Each column
   * carries real sample values because that is how a person actually verifies a
   * mapping — a column called "Contact" holding phone numbers is obvious from the
   * data and invisible from the header alone.
   *
   * Tap-driven rather than drag-and-drop: drag targets are unreliable on touch,
   * and a real <button> + listbox gets keyboard and screen-reader support for free.
   */
  import {
    FIELD_GROUPS,
    FIELD_LABELS,
    FIELD_HINTS,
    assignField,
    invertMapping,
    sampleValues,
    mappingSummary,
    type ColumnMapping,
    type ImportField,
  } from "./csv-import.js";

  interface Props {
    headers: string[];
    rows: Record<string, string>[];
    mapping: ColumnMapping;
    onChange: (next: ColumnMapping) => void;
  }

  let { headers, rows, mapping, onChange }: Props = $props();

  /** Which column's role picker is open — null = none. */
  let picking = $state<string | null>(null);
  let showMatched = $state(false);

  const byHeader = $derived(invertMapping(mapping));
  const summary = $derived(mappingSummary(headers, mapping));

  const unmatched = $derived(headers.filter((h) => !byHeader.has(h)));
  const matched = $derived(headers.filter((h) => byHeader.has(h)));

  const samples = $derived(
    new Map(headers.map((h) => [h, sampleValues(rows, h)] as const)),
  );

  function choose(header: string, field: ImportField | null): void {
    onChange(assignField(mapping, header, field));
    picking = null;
  }

  /** The column currently holding a role, so the picker can show what it displaces. */
  function heldBy(field: ImportField): string {
    return mapping[field];
  }
</script>

<div class="mapper">
  <!-- Progress reads as "we did the work, here is what is left" -->
  <div class="readout">
    <div class="bar" role="presentation">
      <span class="bar-fill" style="--pct: {summary.total ? (summary.assigned / summary.total) * 100 : 0}%"></span>
    </div>
    <p class="readout-text">
      <strong>{summary.assigned}</strong> of {summary.total} columns in use
      {#if unmatched.length > 0}<span class="readout-rest"> · {unmatched.length} ignored</span>{/if}
    </p>
  </div>

  {#if !summary.hasEmail}
    <p class="needs-email" role="alert">
      Pick the column that holds the email address — the import needs it.
    </p>
  {/if}

  <!-- Unassigned columns first: these are the only ones needing a decision -->
  {#if unmatched.length > 0}
    <h4 class="group-head">Not used yet</h4>
    <ul class="cols">
      {#each unmatched as header (header)}
        {@render columnCard(header)}
      {/each}
    </ul>
  {/if}

  {#if matched.length > 0}
    <button
      class="group-toggle"
      onclick={() => (showMatched = !showMatched)}
      aria-expanded={showMatched}
    >
      <span class="group-head">Matched</span>
      <span class="group-count">{matched.length}</span>
      <span class="chev" class:open={showMatched} aria-hidden="true">▾</span>
    </button>
    {#if showMatched}
      <ul class="cols">
        {#each matched as header (header)}
          {@render columnCard(header)}
        {/each}
      </ul>
    {/if}
  {/if}
</div>

{#snippet columnCard(header: string)}
  {@const field = byHeader.get(header)}
  {@const vals = samples.get(header) ?? []}
  <li class="col" class:assigned={field} class:open={picking === header}>
    <div class="col-body">
      <p class="col-head" title={header}>{header}</p>
      {#if vals.length > 0}
        <p class="col-sample">
          {#each vals as v, i (i)}<span class="cell">{v}</span>{/each}
        </p>
      {:else}
        <p class="col-sample empty">no values in this column</p>
      {/if}
    </div>

    <button
      class="role"
      class:unset={!field}
      onclick={() => (picking = picking === header ? null : header)}
      aria-expanded={picking === header}
      aria-label="Role for column {header}"
    >
      {field ? FIELD_LABELS[field] : "Ignore"}
      <span class="chev" class:open={picking === header} aria-hidden="true">▾</span>
    </button>

    {#if picking === header}
      <div class="picker" role="listbox" aria-label="Choose what {header} holds">
        {#each FIELD_GROUPS as group (group.id)}
          <p class="picker-group">{group.label}</p>
          {#each group.fields as f (f)}
            {@const taken = heldBy(f)}
            <button
              class="opt"
              class:on={field === f}
              role="option"
              aria-selected={field === f}
              onclick={() => choose(header, f)}
            >
              <span class="opt-label">
                {FIELD_LABELS[f]}
                {#if FIELD_HINTS[f]}<span class="opt-hint">{FIELD_HINTS[f]}</span>{/if}
              </span>
              {#if taken && taken !== header}
                <!-- One role, one column: say what this replaces before it happens -->
                <span class="opt-taken">on {taken}</span>
              {/if}
            </button>
          {/each}
        {/each}
        <button class="opt skip" class:on={!field} role="option" aria-selected={!field} onclick={() => choose(header, null)}>
          <span class="opt-label">Ignore this column<span class="opt-hint">Nothing from it is imported</span></span>
        </button>
      </div>
    {/if}
  </li>
{/snippet}

<style>
  .mapper { display: flex; flex-direction: column; gap: 0.75rem; }

  /* ── Progress readout ───────────────────────────────────────────────────── */
  .readout { display: flex; flex-direction: column; gap: 0.4rem; }

  .bar {
    height: 3px;
    background: var(--bg-input);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .bar-fill {
    display: block;
    height: 100%;
    width: var(--pct);
    background: var(--accent);
    transition: width var(--transition);
  }

  .readout-text { margin: 0; font-size: 0.75rem; color: var(--text-muted); }
  .readout-text strong { color: var(--text); font-family: var(--font-mono); }
  .readout-rest { color: var(--text-dim); }

  .needs-email {
    margin: 0;
    padding: 0.625rem 0.75rem;
    font-size: 0.8125rem;
    color: var(--warning);
    border: 1px solid var(--warning);
    border-radius: var(--radius-md);
    background: rgba(255, 176, 32, 0.08);
  }

  /* ── Group headings ─────────────────────────────────────────────────────── */
  .group-head {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-dim);
  }

  .group-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0;
    width: 100%;
    text-align: left;
    transition: color var(--transition);
  }
  .group-toggle:hover .group-head { color: var(--text-secondary); }

  .group-count {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.05rem 0.3rem;
  }

  .chev {
    font-size: 0.625rem;
    color: var(--text-muted);
    transition: transform var(--transition);
  }
  .chev.open { transform: rotate(180deg); }

  /* ── Column cards ───────────────────────────────────────────────────────── */
  .cols { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.375rem; }

  .col {
    position: relative;
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-input);
    transition: border-color var(--transition), background var(--transition);
  }
  .col.assigned { background: var(--bg-surface); }
  .col.open { border-color: var(--accent); }

  .col-body { min-width: 0; }

  .col-head {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The signature: their own data, so a mis-mapping is visible at a glance */
  .col-sample {
    margin: 0.2rem 0 0;
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .col-sample.empty { color: var(--text-dim); font-style: italic; }
  .cell + .cell::before { content: " · "; color: var(--text-dim); }

  .role {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.6rem;
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
    color: var(--accent-text);
    background: var(--accent-subtle);
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    transition: background var(--transition), border-color var(--transition);
  }
  .role:hover { background: rgba(199, 242, 58, 0.18); }
  .role.unset {
    color: var(--text-muted);
    background: transparent;
    border-color: var(--border);
  }
  .role.unset:hover { color: var(--text); border-color: var(--border-hover); }

  /* ── Role picker ────────────────────────────────────────────────────────── */
  .picker {
    grid-column: 1 / -1;
    margin-top: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    max-height: 17rem;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .picker-group {
    margin: 0.5rem 0 0.2rem;
    font-family: var(--font-mono);
    font-size: 0.625rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .picker-group:first-child { margin-top: 0; }

  .opt {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    width: 100%;
    text-align: left;
    /* 44px min touch target — this is the step's primary control on mobile */
    min-height: 44px;
    padding: 0.4rem 0.5rem;
    border-radius: var(--radius-sm);
    font-size: 0.8125rem;
    color: var(--text-secondary);
    transition: background var(--transition), color var(--transition);
  }
  .opt:hover { background: var(--bg-surface-hover); color: var(--text); }
  .opt.on { color: var(--accent-text); background: var(--accent-subtle); }
  .opt.skip { margin-top: 0.4rem; border-top: 1px solid var(--border); border-radius: 0; }

  .opt-label { display: flex; flex-direction: column; gap: 0.1rem; }
  .opt-hint { font-size: 0.6875rem; color: var(--text-dim); }
  .opt-taken {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 0.625rem;
    color: var(--warning);
  }

  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  @media (max-width: 480px) {
    .col { grid-template-columns: 1fr; align-items: start; }
    .role { justify-self: start; }
  }

  @media (prefers-reduced-motion: reduce) {
    .bar-fill, .chev, .col, .role, .opt { transition: none; }
  }
</style>
