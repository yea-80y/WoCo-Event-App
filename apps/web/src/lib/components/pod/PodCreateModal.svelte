<script lang="ts">
  /**
   * PodCreateModal — mint a standalone badge / collectible POD type.
   *
   * The crypto-sensitive half of the POD manager: the manifest is built and
   * ed25519-signed CLIENT-side with the creator's POD key (reusing the exact
   * event-creation builder), then handed to the server which uploads it,
   * sponsor-registers it on-chain, and writes the directory entry. The artwork
   * is display-layer only (uploaded separately, stored on the directory entry,
   * never in the signed manifest).
   *
   * Centered dialog — deliberately distinct from the slide-in PodEditDrawer:
   * creating is a committing act, editing is incidental. Concrete & Acid; the
   * single lime affordance is "Mint POD".
   */
  import type { PodCategory, PodDirectoryEntry } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { buildEventManifests } from "../../pod/event-builder.js";
  import { buildCertBadgeManifest } from "../../pod/cert-builder.js";
  import { uploadSiteImage } from "../../api/sites.js";
  import { createPod } from "../../api/pod.js";

  interface Props {
    open: boolean;
    categories: PodCategory[];
    onclose: () => void;
    oncreated: (entry: PodDirectoryEntry) => void;
  }

  let { open, categories, onclose, oncreated }: Props = $props();

  const BEE_GATEWAY = import.meta.env.VITE_GATEWAY_URL || "https://gateway.woco-net.com";

  /**
   * What the organiser is choosing between. `ticket` flows through events and
   * `authenticity` is unbuilt, so neither appears.
   *
   * `cert-badge` is a UI kind, not a server kind: it mints `kind: "badge"` with
   * `holdingSource: "pod-cert"`. It is a full third card rather than a toggle
   * under BADGE because the choice is IRREVERSIBLE at mint — the two rails
   * produce structurally different artifacts (one template body versus one per
   * edition, chain registration versus none) — and this grid is already where
   * the modal stages its one committing decision. A source toggle underneath
   * would read as a display preference, and it is the quiet switch that gets
   * missed.
   */
  type UiKind = "badge" | "collectible" | "cert-badge";
  const KINDS: { value: UiKind; label: string; blurb: string }[] = [
    { value: "badge", label: "BADGE", blurb: "Loyalty / achievement — soulbound" },
    { value: "collectible", label: "DROP", blurb: "Limited drop or memento — soulbound" },
    { value: "cert-badge", label: "AWARD", blurb: "You award it to named people — no chain" },
  ];

  // ── form state ──────────────────────────────────────────────────────────
  let kind = $state<UiKind>("badge");
  const isCert = $derived(kind === "cert-badge");
  let name = $state("");
  let description = $state("");
  let supply = $state(100);
  let categoryId = $state("");
  let image = $state<string | undefined>(undefined);
  let previewSrc = $state<string | undefined>(undefined);

  // ── flow state ──────────────────────────────────────────────────────────
  let uploading = $state(false);
  let working = $state(false);
  let step = $state("");
  let error = $state("");

  const canMint = $derived(
    !!name.trim() && Number.isInteger(supply) && supply >= 1 && supply <= 10000 && !working && !uploading,
  );

  // Reset the form each time the modal opens.
  $effect(() => {
    if (open) {
      kind = "badge";
      name = "";
      description = "";
      supply = 100;
      categoryId = "";
      image = undefined;
      previewSrc = undefined;
      uploading = false;
      working = false;
      step = "";
      error = "";
    }
  });

  async function pickImage(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      uploading = true;
      error = "";
      try {
        const res = await uploadSiteImage(reader.result as string);
        if (!res.ok || !res.data) throw new Error(res.error ?? "Upload failed");
        image = res.data.imageRef;
        previewSrc = `${BEE_GATEWAY}/bytes/${image}`;
      } catch (err) {
        error = err instanceof Error ? err.message : "Image upload failed";
      } finally {
        uploading = false;
      }
    };
    reader.readAsDataURL(file);
  }

  function removeImage() {
    image = undefined;
    previewSrc = undefined;
  }

  async function mint() {
    if (!canMint) return;
    working = true;
    error = "";
    try {
      // ── Auth: session + POD identity (same gates as event publish). ───────
      if (!auth.hasSession) {
        step = "Approve session…";
        if (!(await auth.ensureSession())) {
          error = "Session delegation cancelled";
          return;
        }
      }
      if (!auth.hasPodIdentity) {
        step = "Approve identity…";
        if (!(await auth.ensurePodIdentity())) {
          error = "Identity setup cancelled";
          return;
        }
      }
      const keypair = await auth.getPodKeypair();
      if (!keypair) {
        error = "Could not get signing key";
        return;
      }

      // ── The certificate rail needs one more key than the chain rail, and
      //    getting it WRONG is not an error anywhere. `certLogOwner` is the
      //    owner half of every chunk address in this badge's log
      //    (`keccak256(identifier ‖ owner)`), and it appears in no public
      //    artifact — so a badge minted under the wrong one has a log that
      //    nobody, including its own issuer on another device, can ever find.
      //    It must be the address the issuing client will actually write under,
      //    which is why it comes from the signer itself and is never typed,
      //    guessed, or taken from `auth.parent`. ────────────────────────────
      let certLogOwner: string | undefined;
      if (isCert) {
        step = "Unlocking your feed signer…";
        const signer = await auth.getContentFeedSigner();
        if (!signer) {
          error = "Could not unlock your feed signer — a certificate badge needs it to publish its log.";
          return;
        }
        certLogOwner = signer.address;
      }

      // ── Build + sign the manifest client-side. Two rails, two builders: a
      //    chain POD commits one body per claimable edition, a certificate
      //    badge commits ONE template body while `totalSupply` declares a
      //    holder cap. Both seal through the same core (`pod/seal.ts`). ──────
      step = "Signing manifest…";
      const organiserAddress = (auth.parent as string).toLowerCase();
      const built = isCert
        ? buildCertBadgeManifest({
            organiserAddress,
            creatorPodPrivateKey: keypair.privateKey,
            creatorPodPublicKeyHex: keypair.publicKeyHex,
            name: name.trim(),
            description: description.trim(),
            ...(image ? { imageHash: image } : {}),
            cap: supply,
          })
        : buildEventManifests({
            organiserAddress,
            organiserNonce: 0n,
            creatorPodPrivateKey: keypair.privateKey,
            creatorPodPublicKeyHex: keypair.publicKeyHex,
            eventMeta: image ? { imageHash: image } : {},
            series: [{ seriesId: crypto.randomUUID(), name: name.trim(), description: description.trim(), totalSupply: supply }],
          })[0]!;

      step = isCert ? "Creating badge…" : "Minting on-chain…";
      const entry = await createPod({
        // A certificate badge IS a badge to everything downstream; the rail is
        // carried by `holdingSource`, not by a fourth `PodKind`.
        kind: isCert ? "badge" : kind,
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(categoryId ? { categoryId } : {}),
        supply,
        signedManifest: built.signedManifest,
        podBodies: built.podBodies,
        ...(image ? { image } : {}),
        ...(isCert ? { holdingSource: "pod-cert" as const, certLogOwner: certLogOwner! } : {}),
      });

      oncreated(entry);
      onclose();
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to create POD";
    } finally {
      working = false;
    }
  }

  function onScrimKey(e: KeyboardEvent) {
    if (e.key === "Escape" && !working) onclose();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="scrim"
    role="button"
    aria-label="Close"
    tabindex="-1"
    onclick={() => !working && onclose()}
    onkeydown={onScrimKey}
  ></div>

  <div class="modal" role="dialog" aria-modal="true" aria-label="Create POD">
    <header class="modal-head">
      <div class="head-meta">
        <span class="kicker">New POD</span>
        <h2>Create a POD</h2>
      </div>
      <button class="close-btn" onclick={onclose} disabled={working} aria-label="Close">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M1 1l12 12M13 1L1 13" /></svg>
      </button>
    </header>

    <div class="scroll">
      <!-- kind selector -->
      <span class="field-label">Kind</span>
      <div class="kind-grid">
        {#each KINDS as k (k.value)}
          <button
            class="kind-opt"
            class:active={kind === k.value}
            onclick={() => (kind = k.value)}
            disabled={working}
            type="button"
          >
            <span class="kind-tag">{k.label}</span>
            <span class="kind-blurb">{k.blurb}</span>
          </button>
        {/each}
      </div>

      {#if isCert}
        <!-- Said at the moment of choosing, because the choice cannot be undone
             and because two of these three facts surprise people. -->
        <p class="rail-note">
          You award this one — nobody claims or buys it. Each award is a record
          you sign naming that person's badge key, published under your own
          account, with no chain and no gas. Awards are <strong>public and
          permanent</strong>, and this version cannot revoke one.
        </p>
      {/if}

      <label class="field-label" for="pod-name">Name</label>
      <input
        id="pod-name"
        class="field-input"
        type="text"
        bind:value={name}
        maxlength={120}
        placeholder="e.g. Festival Regular"
        disabled={working}
      />

      <label class="field-label" for="pod-desc">Description</label>
      <textarea
        id="pod-desc"
        class="field-textarea"
        bind:value={description}
        maxlength={400}
        rows={2}
        placeholder="Short description (optional)"
        disabled={working}
      ></textarea>

      <div class="row">
        <div class="col">
          <label class="field-label" for="pod-supply">{isCert ? "Holder cap" : "Supply"}</label>
          <input
            id="pod-supply"
            class="field-input"
            type="number"
            bind:value={supply}
            min={1}
            max={10000}
            disabled={working}
          />
          <span class="field-hint">
            {#if isCert}
              People this badge can ever name (1–10,000). Signed into the badge and
              immutable — but nothing at a door enforces it, so over-issuing shows
              up in your own log rather than being blocked. Your issuing device
              refuses to go past it.
            {:else}
              Editions this POD can ever issue (1–10,000). Immutable once minted.
            {/if}
          </span>
        </div>
        <div class="col">
          <label class="field-label" for="pod-cat">Category</label>
          <select id="pod-cat" class="field-select" bind:value={categoryId} disabled={working}>
            <option value="">— Uncategorised —</option>
            {#each [...categories].sort((a, b) => a.sortIndex - b.sortIndex) as cat (cat.id)}
              <option value={cat.id}>{cat.label}</option>
            {/each}
          </select>
        </div>
      </div>

      <span class="field-label">Artwork</span>
      <div class="artwork-row">
        {#if previewSrc}
          <div class="art-thumb"><img src={previewSrc} alt="POD artwork" /></div>
          <div class="art-actions">
            <label class="btn btn--ghost btn--sm">
              {#if uploading}Uploading…{:else}Replace{/if}
              <input type="file" accept="image/*" class="sr-only" onchange={pickImage} disabled={uploading || working} />
            </label>
            <button class="btn btn--danger btn--sm" onclick={removeImage} disabled={uploading || working}>Remove</button>
          </div>
        {:else}
          <label class="upload-zone" class:uploading>
            {#if uploading}
              <span class="upload-label">Uploading…</span>
            {:else}
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13V4m0 0L7 7m3-3l3 3" /><path d="M3 16h14" /></svg>
              <span class="upload-label">Upload image</span>
              <span class="upload-sub">PNG, JPG, GIF · max 4 MB</span>
            {/if}
            <input type="file" accept="image/*" class="sr-only" onchange={pickImage} disabled={uploading || working} />
          </label>
        {/if}
      </div>

      {#if error}
        <p class="err-msg">{error}</p>
      {/if}
    </div>

    <footer class="modal-foot">
      <button class="btn btn--ghost" onclick={onclose} disabled={working}>Cancel</button>
      <button class="btn btn--primary" onclick={mint} disabled={!canMint}>
        {working ? step || "Working…" : "Mint POD"}
      </button>
    </footer>
  </div>
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
    to { opacity: 1; }
  }

  .modal {
    position: fixed;
    z-index: 201;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(460px, calc(100vw - 32px));
    max-height: calc(100vh - 64px);
    display: flex;
    flex-direction: column;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    animation: pop-in 0.2s cubic-bezier(0.22, 1, 0.36, 1);
  }
  @keyframes pop-in {
    from { opacity: 0; transform: translate(-50%, -48%) scale(0.97); }
    to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  }

  .modal-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 18px 18px 14px;
    border-bottom: 1px solid var(--border);
    flex: 0 0 auto;
  }
  .head-meta { display: flex; flex-direction: column; gap: 4px; }
  .kicker {
    font-family: var(--font-mono);
    font-size: 0.64rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .modal-head h2 {
    font-family: var(--font-display);
    font-size: 1.15rem;
    font-weight: 700;
    color: var(--text);
    margin: 0;
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
  }
  .close-btn:not(:disabled):hover { border-color: var(--border-hover); color: var(--text); }
  .close-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .scroll {
    flex: 1;
    overflow-y: auto;
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  /* kind selector */
  .rail-note {
    margin: 10px 0 0;
    padding: 9px 11px;
    border-left: 2px solid var(--accent);
    background: var(--bg-surface);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    font-size: 0.82rem;
    line-height: 1.5;
    color: var(--text-secondary);
  }

  .kind-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 2px;
  }
  .kind-opt {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    text-align: left;
    padding: 11px 12px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    background: var(--bg-input);
    cursor: pointer;
    transition: border-color var(--transition), background var(--transition);
  }
  .kind-opt:not(:disabled):hover { border-color: var(--border-hover); }
  .kind-opt.active {
    border-color: var(--accent);
    background: var(--accent-subtle);
  }
  .kind-opt:disabled { opacity: 0.6; cursor: not-allowed; }
  .kind-tag {
    font-family: var(--font-tag);
    font-size: 0.62rem;
    letter-spacing: 0.08em;
    color: var(--text);
  }
  .kind-blurb {
    font-size: 0.72rem;
    color: var(--text-muted);
    line-height: 1.3;
  }

  .field-label {
    font-family: var(--font-mono);
    font-size: 0.65rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-top: 14px;
    margin-bottom: 6px;
  }
  .field-hint {
    font-size: 0.68rem;
    color: var(--text-dim);
    margin-top: 4px;
    line-height: 1.4;
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
  .field-select:focus { outline: none; border-color: var(--accent); }
  .field-textarea { resize: vertical; min-height: 56px; }
  .field-select {
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' fill='none' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M1 1l4 4 4-4'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 10px center;
    padding-right: 28px;
    cursor: pointer;
  }

  .row { display: flex; gap: 12px; }
  .col { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .col .field-label { margin-top: 14px; }

  /* artwork */
  .artwork-row { display: flex; align-items: flex-start; gap: 10px; }
  .art-thumb {
    width: 72px;
    height: 72px;
    flex: 0 0 auto;
    border-radius: var(--radius-sm);
    overflow: hidden;
    border: 1px solid var(--border);
    background: var(--bg-input);
  }
  .art-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .art-actions { display: flex; flex-direction: column; gap: 6px; }
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
  .upload-zone.uploading { border-color: var(--accent); background: var(--accent-subtle); }
  .upload-zone svg { color: var(--text-dim); }
  .upload-label {
    font-family: var(--font-display);
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .upload-sub { font-family: var(--font-mono); font-size: 0.62rem; color: var(--text-dim); }

  .err-msg { margin-top: 12px; font-size: 0.82rem; color: var(--error); }

  .modal-foot {
    flex: 0 0 auto;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 14px 18px;
    border-top: 1px solid var(--border);
  }

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
  .btn--primary { background: var(--accent); color: var(--accent-ink); }
  .btn--primary:not(:disabled):hover { background: var(--accent-hover); }
  .btn--ghost { background: transparent; color: var(--text); border-color: var(--border-hover); }
  .btn--ghost:not(:disabled):hover { background: var(--bg-surface-hover); }
  .btn--danger { background: transparent; color: var(--error); border-color: var(--error); }
  .btn--danger:not(:disabled):hover { background: rgba(255, 80, 60, 0.08); }
  .btn--sm { font-size: 0.78rem; padding: 5px 10px; }

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
