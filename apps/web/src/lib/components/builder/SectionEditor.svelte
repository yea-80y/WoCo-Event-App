<script lang="ts">
  import type {
    Section,
    HeroSection,
    RichTextSection,
    GallerySection,
    EventsGridSection,
    FeaturedEventSection,
    OpeningHoursSection,
    MapSection,
    ContactFormSection,
    EmbedSection,
  } from "@woco/shared";

  interface Props {
    section: Section;
    onpatch: (patch: Record<string, unknown>) => void;
  }

  let { section, onpatch }: Props = $props();

  function addHoursRow() {
    const rows = [...(section as OpeningHoursSection).rows, { day: '', hours: '' }];
    onpatch({ rows });
  }

  function removeHoursRow(i: number) {
    const rows = (section as OpeningHoursSection).rows.filter((_, k) => k !== i);
    onpatch({ rows });
  }

  function patchHoursRow(i: number, field: 'day' | 'hours', value: string) {
    const rows = (section as OpeningHoursSection).rows.map((r, k) =>
      k === i ? { ...r, [field]: value } : r
    );
    onpatch({ rows });
  }
</script>

<div class="section-editor">
  {#if section.type === 'hero'}
    {@const s = section as HeroSection}
    <label class="field-row">
      <span class="field-label">Heading</span>
      <input class="input" type="text" value={s.heading} placeholder="Hero heading"
        oninput={(e) => onpatch({ heading: (e.currentTarget as HTMLInputElement).value })} />
    </label>
    <label class="field-row">
      <span class="field-label">Subheading</span>
      <input class="input" type="text" value={s.subheading ?? ''} placeholder="Optional subheading"
        oninput={(e) => onpatch({ subheading: (e.currentTarget as HTMLInputElement).value })} />
    </label>
    <label class="field-row">
      <span class="field-label">CTA label</span>
      <input class="input" type="text" value={s.ctaLabel ?? ''} placeholder="e.g. What's On"
        oninput={(e) => onpatch({ ctaLabel: (e.currentTarget as HTMLInputElement).value })} />
    </label>
    <label class="field-row">
      <span class="field-label">CTA link</span>
      <input class="input" type="text" value={s.ctaHref ?? ''} placeholder="#/whats-on or https://…"
        oninput={(e) => onpatch({ ctaHref: (e.currentTarget as HTMLInputElement).value })} />
    </label>

  {:else if section.type === 'richText'}
    {@const s = section as RichTextSection}
    <label class="field-row">
      <span class="field-label">Markdown</span>
      <textarea class="input textarea" rows="8" value={s.markdown}
        placeholder="## Heading&#10;&#10;Your content here…"
        oninput={(e) => onpatch({ markdown: (e.currentTarget as HTMLTextAreaElement).value })}
      ></textarea>
    </label>

  {:else if section.type === 'gallery'}
    {@const s = section as GallerySection}
    <p class="hint">Image upload via Swarm will be wired up in Phase 2.</p>
    {#if s.images.length > 0}
      <div class="gallery-list">
        {#each s.images as img}
          <div class="gallery-item">
            <code class="mono">{img.ref.slice(0, 16)}…</code>
            <span class="gallery-alt">{img.alt || '(no alt)'}</span>
          </div>
        {/each}
      </div>
    {:else}
      <p class="hint muted">No images yet.</p>
    {/if}

  {:else if section.type === 'eventsGrid'}
    {@const s = section as EventsGridSection}
    <label class="field-row">
      <span class="field-label">Mode</span>
      <select class="input select" value={s.mode}
        onchange={(e) => onpatch({ mode: (e.currentTarget as HTMLSelectElement).value })}>
        <option value="upcoming">Upcoming</option>
        <option value="all">All events</option>
        <option value="featured">Featured only</option>
      </select>
    </label>
    <label class="field-row">
      <span class="field-label">Max cards <span class="optional">(optional)</span></span>
      <input class="input" type="number" min="1" value={s.max ?? ''}
        placeholder="Unlimited"
        oninput={(e) => {
          const v = (e.currentTarget as HTMLInputElement).value;
          onpatch({ max: v ? parseInt(v, 10) : undefined });
        }} />
    </label>

  {:else if section.type === 'featuredEvent'}
    {@const s = section as FeaturedEventSection}
    <label class="field-row">
      <span class="field-label">Event ID</span>
      <input class="input" type="text" value={s.eventId}
        placeholder="Paste event ID from your dashboard"
        oninput={(e) => onpatch({ eventId: (e.currentTarget as HTMLInputElement).value })} />
      <span class="hint">Copy from the Events tab in your dashboard.</span>
    </label>

  {:else if section.type === 'openingHours'}
    {@const s = section as OpeningHoursSection}
    <div class="hours-table">
      {#each s.rows as row, i}
        <div class="hours-row">
          <input class="input hours-day" type="text" value={row.day} placeholder="Day(s)"
            oninput={(e) => patchHoursRow(i, 'day', (e.currentTarget as HTMLInputElement).value)} />
          <input class="input hours-time" type="text" value={row.hours} placeholder="Hours"
            oninput={(e) => patchHoursRow(i, 'hours', (e.currentTarget as HTMLInputElement).value)} />
          <button class="btn-icon danger" onclick={() => removeHoursRow(i)} title="Remove row">&#10005;</button>
        </div>
      {/each}
      <button class="btn-ghost add-row-btn" onclick={addHoursRow}>+ Add row</button>
    </div>

  {:else if section.type === 'map'}
    {@const s = section as MapSection}
    <div class="field-grid-2">
      <label class="field-row">
        <span class="field-label">Latitude</span>
        <input class="input" type="number" step="any" value={s.lat}
          oninput={(e) => onpatch({ lat: parseFloat((e.currentTarget as HTMLInputElement).value) || 0 })} />
      </label>
      <label class="field-row">
        <span class="field-label">Longitude</span>
        <input class="input" type="number" step="any" value={s.lng}
          oninput={(e) => onpatch({ lng: parseFloat((e.currentTarget as HTMLInputElement).value) || 0 })} />
      </label>
    </div>
    <div class="field-grid-2">
      <label class="field-row">
        <span class="field-label">Zoom (1–20)</span>
        <input class="input" type="number" min="1" max="20" value={s.zoom ?? 14}
          oninput={(e) => onpatch({ zoom: parseInt((e.currentTarget as HTMLInputElement).value, 10) || 14 })} />
      </label>
      <label class="field-row">
        <span class="field-label">Pin label</span>
        <input class="input" type="text" value={s.label ?? ''} placeholder="Venue name"
          oninput={(e) => onpatch({ label: (e.currentTarget as HTMLInputElement).value })} />
      </label>
    </div>

  {:else if section.type === 'contactForm'}
    {@const s = section as ContactFormSection}
    <label class="field-row">
      <span class="field-label">Deliver submissions to</span>
      <input class="input" type="email" value={s.emailTo} placeholder="hello@yourvenue.com"
        oninput={(e) => onpatch({ emailTo: (e.currentTarget as HTMLInputElement).value })} />
    </label>

  {:else if section.type === 'embed'}
    {@const s = section as EmbedSection}
    <label class="field-row">
      <span class="field-label">HTML embed</span>
      <textarea class="input textarea" rows="4" value={s.html}
        placeholder="<iframe …></iframe>"
        oninput={(e) => onpatch({ html: (e.currentTarget as HTMLTextAreaElement).value })}
      ></textarea>
      <span class="hint warn">HTML is sanitized at render time — only &lt;iframe&gt; and basic HTML allowed.</span>
    </label>
  {/if}
</div>

<style>
  .section-editor {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.875rem 1rem;
    background: var(--bg);
    border-top: 1px solid var(--border);
  }

  .field-row {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .field-grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }

  .field-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .optional {
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    color: var(--text-muted);
    font-size: 0.6875rem;
  }

  .input {
    padding: 0.5rem 0.75rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 0.875rem;
    font-family: inherit;
    transition: border-color var(--transition);
    width: 100%;
    box-sizing: border-box;
  }

  .input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .textarea {
    resize: vertical;
    line-height: 1.5;
    font-family: monospace;
    font-size: 0.8125rem;
  }

  .select {
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23666'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.75rem center;
    padding-right: 2rem;
    cursor: pointer;
  }

  .hint {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.4;
  }

  .hint.warn { color: #f59e0b; }
  .hint.muted { font-style: italic; }

  .mono {
    font-family: monospace;
    font-size: 0.75rem;
    color: var(--text-secondary);
  }

  .gallery-list { display: flex; flex-direction: column; gap: 0.25rem; }

  .gallery-item {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    font-size: 0.8125rem;
    padding: 0.375rem 0.5rem;
    background: var(--bg-surface);
    border-radius: var(--radius-sm);
  }

  .gallery-alt { color: var(--text-muted); font-style: italic; }

  .hours-table { display: flex; flex-direction: column; gap: 0.375rem; }

  .hours-row {
    display: flex;
    gap: 0.375rem;
    align-items: center;
  }

  .hours-day { flex: 1; }
  .hours-time { flex: 1; }

  .btn-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 0.75rem;
    flex-shrink: 0;
    transition: all var(--transition);
  }

  .btn-icon:hover {
    border-color: var(--error);
    color: var(--error);
    background: color-mix(in srgb, var(--error) 8%, transparent);
  }

  .btn-ghost {
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
    font-weight: 500;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    transition: all var(--transition);
    align-self: flex-start;
  }

  .btn-ghost:hover {
    border-color: var(--accent);
    color: var(--accent-text);
    border-style: solid;
  }

  .add-row-btn { margin-top: 0.25rem; }
</style>
