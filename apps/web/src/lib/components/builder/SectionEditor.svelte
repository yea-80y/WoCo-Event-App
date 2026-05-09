<script lang="ts">
  import type {
    Section,
    HeroSection,
    RichTextSection,
    GallerySection,
    ImageSection,
    EventsGridSection,
    FeaturedEventSection,
    OpeningHoursSection,
    MapSection,
    ContactFormSection,
    EmbedSection,
  } from "@woco/shared";
  import { uploadSiteImage } from "../../api/sites.js";
  import { fileToBase64 } from "../../utils.js";

  interface Props {
    section: Section;
    onpatch: (patch: Record<string, unknown>) => void;
  }

  let { section, onpatch }: Props = $props();

  const GATEWAY_URL = (import.meta as { env?: Record<string, string> }).env?.VITE_GATEWAY_URL ?? 'https://gateway.woco-net.com';

  // ── Gallery upload state ──────────────────────────────────────────────────
  let galleryUploadState = $state<'idle' | 'uploading' | 'error'>('idle');
  let galleryUploadError = $state('');

  async function handleGalleryFile(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    (e.currentTarget as HTMLInputElement).value = '';
    if (!file.type.startsWith('image/')) {
      galleryUploadError = 'Please select an image file';
      galleryUploadState = 'error';
      return;
    }
    galleryUploadState = 'uploading';
    galleryUploadError = '';
    try {
      const base64 = await fileToBase64(file);
      const res = await uploadSiteImage(base64);
      if (res.ok && res.data) {
        const s = section as GallerySection;
        onpatch({ images: [...s.images, { ref: res.data.imageRef, alt: '' }] });
        galleryUploadState = 'idle';
      } else {
        galleryUploadError = res.error ?? 'Upload failed';
        galleryUploadState = 'error';
      }
    } catch {
      galleryUploadError = 'Upload failed — check connection';
      galleryUploadState = 'error';
    }
  }

  function removeGalleryImage(i: number) {
    const s = section as GallerySection;
    onpatch({ images: s.images.filter((_, k) => k !== i) });
  }

  function patchGalleryAlt(i: number, alt: string) {
    const s = section as GallerySection;
    onpatch({ images: s.images.map((img, k) => k === i ? { ...img, alt } : img) });
  }

  // ── Single-image upload state ─────────────────────────────────────────────
  let imageUploadState = $state<'idle' | 'uploading' | 'error'>('idle');
  let imageUploadError = $state('');

  async function handleImageFile(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    (e.currentTarget as HTMLInputElement).value = '';
    if (!file.type.startsWith('image/')) {
      imageUploadError = 'Please select an image file';
      imageUploadState = 'error';
      return;
    }
    imageUploadState = 'uploading';
    imageUploadError = '';
    try {
      const base64 = await fileToBase64(file);
      const res = await uploadSiteImage(base64);
      if (res.ok && res.data) {
        onpatch({ ref: res.data.imageRef });
        imageUploadState = 'idle';
      } else {
        imageUploadError = res.error ?? 'Upload failed';
        imageUploadState = 'error';
      }
    } catch {
      imageUploadError = 'Upload failed — check connection';
      imageUploadState = 'error';
    }
  }

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
  {#if section.type !== 'hero'}
    <div class="field-row spacing-row">
      <span class="field-label">Spacing</span>
      <div class="spacing-toggle">
        <button
          class="spacing-btn"
          class:active={section.spacing === 'compact'}
          onclick={() => onpatch({ spacing: 'compact' })}
          title="Less space above and below this section"
        >Compact</button>
        <button
          class="spacing-btn"
          class:active={!section.spacing || section.spacing === 'default'}
          onclick={() => onpatch({ spacing: 'default' })}
          title="Standard spacing"
        >Default</button>
        <button
          class="spacing-btn"
          class:active={section.spacing === 'spacious'}
          onclick={() => onpatch({ spacing: 'spacious' })}
          title="Extra breathing room above and below"
        >Spacious</button>
      </div>
    </div>
    <hr class="editor-divider" />
  {/if}

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
    <label class="field-row">
      <span class="field-label">Section heading <span class="optional">(optional)</span></span>
      <input class="input" type="text" value={s.title ?? ''} placeholder="e.g. Gallery, Photos"
        oninput={(e) => onpatch({ title: (e.currentTarget as HTMLInputElement).value || undefined })} />
    </label>
    <div class="gallery-editor">
      {#each s.images as img, i}
        <div class="gallery-item">
          <img class="gallery-thumb" src="{GATEWAY_URL}/bytes/{img.ref}" alt={img.alt || ''} loading="lazy" />
          <input
            class="input gallery-alt-input"
            type="text"
            value={img.alt}
            placeholder="Image description (alt text)"
            oninput={(e) => patchGalleryAlt(i, (e.currentTarget as HTMLInputElement).value)}
          />
          <button class="btn-icon danger" onclick={() => removeGalleryImage(i)} title="Remove image">&#10005;</button>
        </div>
      {/each}

      <div class="gallery-upload-row">
        <label class="btn-ghost gallery-upload-label" for="gallery-file-input">
          {#if galleryUploadState === 'uploading'}
            <span class="gallery-spinner" aria-hidden="true"></span>Uploading…
          {:else}
            + Add image
          {/if}
        </label>
        <input
          id="gallery-file-input"
          type="file"
          accept="image/*"
          class="visually-hidden"
          disabled={galleryUploadState === 'uploading'}
          onchange={handleGalleryFile}
        />
      </div>
      {#if galleryUploadState === 'error'}
        <p class="hint error">{galleryUploadError}</p>
      {/if}
    </div>

  {:else if section.type === 'image'}
    {@const s = section as ImageSection}
    <div class="image-editor">
      {#if s.ref}
        <div class="image-preview-wrap">
          <img class="image-preview" src="{GATEWAY_URL}/bytes/{s.ref}" alt={s.alt || ''} loading="lazy" />
          <button class="image-replace-btn btn-ghost" onclick={() => { onpatch({ ref: '' }); imageUploadState = 'idle'; }}>
            Replace image
          </button>
        </div>
      {:else}
        <div class="image-upload-row">
          <label class="btn-ghost image-upload-label" for="image-file-input">
            {#if imageUploadState === 'uploading'}
              <span class="gallery-spinner" aria-hidden="true"></span>Uploading…
            {:else}
              + Upload image
            {/if}
          </label>
          <input
            id="image-file-input"
            type="file"
            accept="image/*"
            class="visually-hidden"
            disabled={imageUploadState === 'uploading'}
            onchange={handleImageFile}
          />
        </div>
        {#if imageUploadState === 'error'}
          <p class="hint error">{imageUploadError}</p>
        {/if}
      {/if}

      {#if s.ref}
        <label class="field-row">
          <span class="field-label">Alt text <span class="optional">(accessibility)</span></span>
          <input class="input" type="text" value={s.alt} placeholder="Describe the image for screen readers"
            oninput={(e) => onpatch({ alt: (e.currentTarget as HTMLInputElement).value })} />
        </label>
        <label class="field-row">
          <span class="field-label">Caption <span class="optional">(optional)</span></span>
          <input class="input" type="text" value={s.caption ?? ''} placeholder="Appears below the image"
            oninput={(e) => onpatch({ caption: (e.currentTarget as HTMLInputElement).value || undefined })} />
        </label>
        <div class="field-row">
          <span class="field-label">Layout</span>
          <div class="layout-toggle">
            <button
              class="layout-btn"
              class:active={s.layout === 'full'}
              onclick={() => onpatch({ layout: 'full' })}
            >Full width</button>
            <button
              class="layout-btn"
              class:active={s.layout === 'contained'}
              onclick={() => onpatch({ layout: 'contained' })}
            >Contained</button>
          </div>
        </div>
      {/if}
    </div>

  {:else if section.type === 'eventsGrid'}
    {@const s = section as EventsGridSection}
    <label class="field-row">
      <span class="field-label">Section heading <span class="optional">(optional)</span></span>
      <input class="input" type="text" value={s.title ?? ''} placeholder="e.g. What's On, Upcoming Events"
        oninput={(e) => onpatch({ title: (e.currentTarget as HTMLInputElement).value || undefined })} />
    </label>
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
      <span class="field-label">Section heading <span class="optional">(optional)</span></span>
      <input class="input" type="text" value={s.title ?? ''} placeholder="e.g. Featured Event, Don't Miss"
        oninput={(e) => onpatch({ title: (e.currentTarget as HTMLInputElement).value || undefined })} />
    </label>
    <label class="field-row">
      <span class="field-label">Event ID</span>
      <input class="input" type="text" value={s.eventId}
        placeholder="Paste event ID from your dashboard"
        oninput={(e) => onpatch({ eventId: (e.currentTarget as HTMLInputElement).value })} />
      <span class="hint">Copy from the Events tab in your dashboard.</span>
    </label>

  {:else if section.type === 'openingHours'}
    {@const s = section as OpeningHoursSection}
    <label class="field-row">
      <span class="field-label">Section heading <span class="optional">(optional)</span></span>
      <input class="input" type="text" value={s.title ?? ''} placeholder="Opening Hours"
        oninput={(e) => onpatch({ title: (e.currentTarget as HTMLInputElement).value || undefined })} />
    </label>
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
    <label class="field-row">
      <span class="field-label">Section heading <span class="optional">(optional)</span></span>
      <input class="input" type="text" value={s.title ?? ''} placeholder="e.g. Find Us, Location"
        oninput={(e) => onpatch({ title: (e.currentTarget as HTMLInputElement).value || undefined })} />
    </label>
    <p class="hint">
      Find your coordinates at <a href="https://www.openstreetmap.org" target="_blank" rel="noopener">openstreetmap.org</a> — right-click your venue → "Show address" and copy the lat/lng from the URL.
    </p>
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
        <input class="input" type="number" min="1" max="20" value={s.zoom ?? 15}
          oninput={(e) => onpatch({ zoom: parseInt((e.currentTarget as HTMLInputElement).value, 10) || 15 })} />
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
      <span class="field-label">Section heading <span class="optional">(optional)</span></span>
      <input class="input" type="text" value={s.title ?? ''} placeholder="Send us a message"
        oninput={(e) => onpatch({ title: (e.currentTarget as HTMLInputElement).value || undefined })} />
    </label>
    <label class="field-row">
      <span class="field-label">Deliver submissions to</span>
      <input class="input" type="email" value={s.emailTo} placeholder="hello@yourvenue.com"
        oninput={(e) => onpatch({ emailTo: (e.currentTarget as HTMLInputElement).value })} />
    </label>

  {:else if section.type === 'embed'}
    {@const s = section as EmbedSection}
    <label class="field-row">
      <span class="field-label">Section heading <span class="optional">(optional)</span></span>
      <input class="input" type="text" value={s.title ?? ''} placeholder="e.g. Book a Table, Follow Us"
        oninput={(e) => onpatch({ title: (e.currentTarget as HTMLInputElement).value || undefined })} />
    </label>
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

  .gallery-editor { display: flex; flex-direction: column; gap: 0.5rem; }

  .gallery-item {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    padding: 0.375rem 0.5rem;
    background: var(--bg-surface);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }

  .gallery-thumb {
    width: 3rem;
    height: 2.25rem;
    object-fit: cover;
    border-radius: 2px;
    flex-shrink: 0;
    background: var(--bg);
  }

  .gallery-alt-input {
    flex: 1;
    font-size: 0.8125rem;
    padding: 0.3125rem 0.5rem;
  }

  .gallery-upload-row { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.125rem; }

  .gallery-upload-label { display: inline-flex; align-items: center; gap: 0.375rem; cursor: pointer; }

  .visually-hidden {
    position: absolute;
    width: 1px; height: 1px;
    overflow: hidden;
    clip: rect(0,0,0,0);
    white-space: nowrap;
  }

  .gallery-spinner {
    display: inline-block;
    width: 0.75rem;
    height: 0.75rem;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .hint.error { color: #ef4444; }

  /* ── Single image editor ── */
  .image-editor { display: flex; flex-direction: column; gap: 0.75rem; }

  .image-preview-wrap {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .image-preview {
    width: 100%;
    max-height: 220px;
    object-fit: cover;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    display: block;
  }

  .image-replace-btn {
    align-self: flex-start;
    font-size: 0.8125rem;
  }

  .image-upload-row { display: flex; align-items: center; gap: 0.5rem; }
  .image-upload-label { display: inline-flex; align-items: center; gap: 0.375rem; cursor: pointer; }

  .layout-toggle {
    display: flex;
    gap: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    align-self: flex-start;
  }

  .layout-btn {
    padding: 0.375rem 0.875rem;
    font-size: 0.8125rem;
    color: var(--text-muted);
    transition: all var(--transition);
    border-right: 1px solid var(--border);
  }

  .layout-btn:last-child { border-right: none; }

  .layout-btn.active {
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }

  .layout-btn:not(.active):hover {
    background: var(--bg-elevated);
    color: var(--text);
  }

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

  /* ── Spacing control ── */
  .spacing-row {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .spacing-toggle {
    display: flex;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .spacing-btn {
    flex: 1;
    padding: 0.3125rem 0.625rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-muted);
    transition: all var(--transition);
    border-right: 1px solid var(--border);
    white-space: nowrap;
  }

  .spacing-btn:last-child { border-right: none; }

  .spacing-btn.active {
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }

  .spacing-btn:not(.active):hover {
    background: var(--bg-elevated);
    color: var(--text);
  }

  .editor-divider {
    border: none;
    border-top: 1px solid var(--border);
    margin: 0.125rem 0;
  }
</style>
