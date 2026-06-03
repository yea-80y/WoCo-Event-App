<script lang="ts">
  /**
   * PodEditDrawer — slide-in panel for viewing + editing one POD type's mutable
   * display layer. Editable: name, description, categoryId, image. Read-only:
   * kind, manifestRef, supply, issuedCount, eventId.
   *
   * Anatomy: full-height right drawer over a scrim. Concrete & Acid, single lime
   * affordance on Save. Vermillion only on the destructive "Remove image" action.
   */
  import type { PodDirectoryEntry, PodCategory } from "@woco/shared";
  import { updatePod } from "../../api/pod.js";
  import { uploadSiteImage } from "../../api/sites.js";

  interface Props {
    pod: PodDirectoryEntry | null;
    categories: PodCategory[];
    onclose: () => void;
    onsaved: (updated: PodDirectoryEntry) => void;
  }

  let { pod, categories, onclose, onsaved }: Props = $props();

  const KIND_LABEL: Record<string, string> = {
    ticket: "TICKET",
    badge: "BADGE",
    collectible: "DROP",
    authenticity: "AUTHENTIC",
  };

  const BEE_GATEWAY = import.meta.env.VITE_GATEWAY_URL || "https://gateway.woco-net.com";

  let saving = $state(false);
  let uploading = $state(false);
  let error = $state("");

  // Local draft — reset when pod changes.
  let draftName = $state("");
  let draftDescription = $state("");
  let draftCategoryId = $state<string>("");
  let draftImage = $state<string | undefined>(undefined);
  let previewSrc = $state<string | undefined>(undefined);

  $effect(() => {
    if (pod) {
      draftName = pod.name;
      draftDescription = pod.description ?? "";
      draftCategoryId = pod.categoryId ?? "";
      draftImage = pod.image;
      previewSrc = pod.image ? `${BEE_GATEWAY}/bzz/${pod.image}/` : undefined;
      error = "";
      saving = false;
      uploading = false;
    }
  });

  function trunc(hex: string, head = 8, tail = 6) {
    if (hex.length <= head + tail + 3) return hex;
    return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
  }

  async function pickImage(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result as string;
      uploading = true;
      error = "";
      try {
        const res = await uploadSiteImage(base64);
        if (!res.ok || !res.data) throw new Error(res.error ?? "Upload failed");
        draftImage = res.data.imageRef;
        previewSrc = `${BEE_GATEWAY}/bzz/${draftImage}/`;
      } catch (e) {
        error = e instanceof Error ? e.message : "Image upload failed";
      } finally {
        uploading = false;
      }
    };
    reader.readAsDataURL(file);
  }

  function removeImage() {
    draftImage = undefined;
    previewSrc = undefined;
  }

  async function save() {
    if (!pod || !draftName.trim()) return;
    saving = true;
    error = "";
    try {
      const updated = await updatePod(pod.manifestRef, {
        name: draftName.trim(),
        description: draftDescription.trim() || undefined,
        image: draftImage,
        categoryId: draftCategoryId || null,
      });
      onsaved(updated);
      onclose();
    } catch (e) {
      error = e instanceof Error ? e.message : "Save failed";
    } finally {
      saving = false;
    }
  }

  function onScrimKey(e: KeyboardEvent) {
    if (e.key === "Escape") onclose();
  }
</script>

{#if pod}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="scrim" role="button" aria-label="Close" onclick={onclose} onkeydown={onScrimKey} tabindex="-1"></div>

  <aside class="drawer" aria-label="Edit POD">
    <header class="drawer-head">
      <div class="head-meta">
        <span class="kind-chip">{KIND_LABEL[pod.kind] ?? pod.kind}</span>
        <h2 class="head-title">{pod.name}</h2>
      </div>
      <button class="close-btn" onclick={onclose} aria-label="Close">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <path d="M1 1l12 12M13 1L1 13" />
        </svg>
      </button>
    </header>

    <div class="scroll">
      <!-- Read-only facts -->
      <section class="facts">
        <dl class="fact-grid">
          <div class="fact">
            <dt>Ref</dt>
            <dd class="mono" title={pod.manifestRef}>{trunc(pod.manifestRef)}</dd>
          </div>
          <div class="fact">
            <dt>Supply</dt>
            <dd class="mono">{pod.issuedCount ?? 0} / {pod.supply}</dd>
          </div>
          {#if pod.eventId}
            <div class="fact">
              <dt>Event ID</dt>
              <dd class="mono" title={pod.eventId}>{trunc(pod.eventId)}</dd>
            </div>
          {/if}
          <div class="fact">
            <dt>Created</dt>
            <dd>{new Date(pod.createdAt).toLocaleDateString()}</dd>
          </div>
        </dl>
      </section>

      <div class="divider"></div>

      <!-- Editable fields -->
      <section class="edit-section">
        <label class="field-label" for="pod-name">Name</label>
        <input
          id="pod-name"
          class="field-input"
          type="text"
          bind:value={draftName}
          maxlength={120}
          placeholder="POD display name"
        />

        <label class="field-label" for="pod-desc">Description</label>
        <textarea
          id="pod-desc"
          class="field-textarea"
          bind:value={draftDescription}
          maxlength={400}
          rows={3}
          placeholder="Short description (optional)"
        ></textarea>

        <label class="field-label" for="pod-cat">Category</label>
        <select id="pod-cat" class="field-select" bind:value={draftCategoryId}>
          <option value="">— Uncategorised —</option>
          {#each [...categories].sort((a, b) => a.sortIndex - b.sortIndex) as cat (cat.id)}
            <option value={cat.id}>{cat.label}</option>
          {/each}
        </select>

        <span class="field-label">Artwork</span>
        <div class="artwork-row">
          {#if previewSrc}
            <div class="art-thumb">
              <img src={previewSrc} alt="POD artwork" />
            </div>
            <div class="art-actions">
              <label class="btn btn--ghost btn--sm">
                {#if uploading}Uploading…{:else}Replace{/if}
                <input type="file" accept="image/*" class="sr-only" onchange={pickImage} disabled={uploading} />
              </label>
              <button class="btn btn--danger btn--sm" onclick={removeImage} disabled={uploading}>Remove</button>
            </div>
          {:else}
            <label class="upload-zone" class:uploading>
              {#if uploading}
                <span class="upload-label">Uploading…</span>
              {:else}
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M10 13V4m0 0L7 7m3-3l3 3" /><path d="M3 16h14" />
                </svg>
                <span class="upload-label">Upload image</span>
                <span class="upload-sub">PNG, JPG, GIF · max 4 MB</span>
              {/if}
              <input type="file" accept="image/*" class="sr-only" onchange={pickImage} disabled={uploading} />
            </label>
          {/if}
        </div>
      </section>

      {#if error}
        <p class="err-msg">{error}</p>
      {/if}
    </div>

    <footer class="drawer-foot">
      <button class="btn btn--ghost" onclick={onclose} disabled={saving}>Cancel</button>
      <button class="btn btn--primary" onclick={save} disabled={saving || uploading || !draftName.trim()}>
        {saving ? "Saving…" : "Save"}
      </button>
    </footer>
  </aside>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: rgba(0, 0, 0, 0.55);
    animation: scrim-in 0.15s ease;
  }
  @keyframes scrim-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 201;
    width: min(400px, 100vw);
    background: var(--bg-elevated);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    animation: slide-in 0.22s cubic-bezier(0.22, 1, 0.36, 1);
  }
  @keyframes slide-in {
    from { transform: translateX(100%); }
    to   { transform: translateX(0); }
  }

  /* ── header ─────────────────────────────────────────────────────── */
  .drawer-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 18px 18px 14px;
    border-bottom: 1px solid var(--border);
    flex: 0 0 auto;
  }
  .head-meta {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .kind-chip {
    display: inline-block;
    font-family: var(--font-tag);
    font-size: 0.58rem;
    letter-spacing: 0.08em;
    color: var(--text);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 3px 8px 2px;
    line-height: 1;
    width: fit-content;
  }
  .head-title {
    font-family: var(--font-display);
    font-size: 1.05rem;
    font-weight: 700;
    color: var(--text);
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 28ch;
  }
  .close-btn {
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: border-color var(--transition), color var(--transition);
    margin-top: 2px;
  }
  .close-btn:hover {
    border-color: var(--border-hover);
    color: var(--text);
  }

  /* ── scroll area ─────────────────────────────────────────────────── */
  .scroll {
    flex: 1;
    overflow-y: auto;
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  /* ── read-only facts ─────────────────────────────────────────────── */
  .facts {
    margin-bottom: 16px;
  }
  .fact-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin: 0;
  }
  .fact {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .fact dt {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .fact dd {
    font-size: 0.82rem;
    color: var(--text-secondary);
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fact dd.mono {
    font-family: var(--font-mono);
    font-size: 0.76rem;
  }

  .divider {
    height: 1px;
    background: var(--border);
    margin-bottom: 16px;
  }

  /* ── edit fields ─────────────────────────────────────────────────── */
  .edit-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .field-label {
    font-family: var(--font-mono);
    font-size: 0.65rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-top: 10px;
  }
  .field-input,
  .field-textarea,
  .field-select {
    width: 100%;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-family: var(--font-body);
    font-size: 0.88rem;
    padding: 8px 10px;
    transition: border-color var(--transition);
    box-sizing: border-box;
  }
  .field-input:focus,
  .field-textarea:focus,
  .field-select:focus {
    outline: none;
    border-color: var(--accent);
  }
  .field-textarea {
    resize: vertical;
    min-height: 72px;
  }
  .field-select {
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' fill='none' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M1 1l4 4 4-4'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 10px center;
    padding-right: 28px;
    cursor: pointer;
  }

  /* artwork upload */
  .artwork-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-top: 2px;
  }
  .art-thumb {
    width: 72px;
    height: 72px;
    flex: 0 0 auto;
    border-radius: var(--radius-sm);
    overflow: hidden;
    border: 1px solid var(--border);
    background: var(--bg-input);
  }
  .art-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .art-actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .upload-zone {
    flex: 1;
    min-height: 80px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    border: 1px dashed var(--border-hover);
    border-radius: var(--radius-sm);
    background: var(--bg-input);
    cursor: pointer;
    padding: 14px;
    transition: border-color var(--transition), background var(--transition);
  }
  .upload-zone:hover,
  .upload-zone.uploading {
    border-color: var(--accent);
    background: var(--accent-subtle);
  }
  .upload-zone svg { color: var(--text-dim); }
  .upload-label {
    font-family: var(--font-display);
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .upload-sub {
    font-family: var(--font-mono);
    font-size: 0.62rem;
    color: var(--text-dim);
  }

  .err-msg {
    margin-top: 10px;
    font-size: 0.82rem;
    color: var(--error);
  }

  /* ── footer ──────────────────────────────────────────────────────── */
  .drawer-foot {
    flex: 0 0 auto;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 14px 18px;
    border-top: 1px solid var(--border);
    background: var(--bg-elevated);
  }

  /* ── buttons ─────────────────────────────────────────────────────── */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 0.86rem;
    padding: 8px 14px;
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    cursor: pointer;
    transition: background var(--transition), border-color var(--transition), color var(--transition);
    white-space: nowrap;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn--primary {
    background: var(--accent);
    color: var(--accent-ink);
  }
  .btn--primary:not(:disabled):hover { background: var(--accent-hover); }
  .btn--ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-hover);
  }
  .btn--ghost:not(:disabled):hover { background: var(--bg-surface-hover); }
  .btn--danger {
    background: transparent;
    color: var(--error);
    border-color: var(--error);
  }
  .btn--danger:not(:disabled):hover { background: rgba(255, 80, 60, 0.08); }
  .btn--sm {
    font-size: 0.78rem;
    padding: 5px 10px;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
