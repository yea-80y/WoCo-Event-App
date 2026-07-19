<script lang="ts">
  import type { EventFeed, EventGeo, EventTag } from "@woco/shared";
  import type { ContentFeedSigner } from "../../swarm/content-feed.js";
  import { updateEventMeta, deleteEvent } from "../../api/events.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import ImageUpload from "./ImageUpload.svelte";
  import LocationPicker from "./LocationPicker.svelte";
  import GenreTagPicker from "./GenreTagPicker.svelte";
  import { toLocalInput } from "./date.js";

  interface Props {
    event: EventFeed;
    /** Tickets already issued (orders) — non-zero disables delete client-side;
     *  the server independently re-verifies (incl. live holds) either way. */
    ordersCount: number;
    /** Approval requests still pending — also blocks delete. */
    pendingCount: number;
    onsaved: (feed: EventFeed) => void;
    ondeleted: () => void;
  }

  let { event, ordersCount, pendingCount, onsaved, ondeleted }: Props = $props();

  const BEE_GATEWAY = import.meta.env.VITE_GATEWAY_URL || "https://gateway.woco-net.com";

  // Drafts seeded from the feed as first rendered; dates convert ISO → local
  // picker format. One-time capture is intentional — later prop refreshes must
  // not clobber in-progress edits (dirty-checks in buildUpdates read the live prop).
  // svelte-ignore state_referenced_locally
  const initial = event;
  let title = $state(initial.title);
  let tagline = $state(initial.tagline ?? "");
  let description = $state(initial.description);
  let startDate = $state(toLocalInput(new Date(initial.startDate)));
  let endDate = $state(toLocalInput(new Date(initial.endDate)));
  let location = $state(initial.location);
  let geo = $state<EventGeo | undefined>(initial.geo);
  let tags = $state<EventTag[]>(initial.tags ?? []);
  // Seeded with the CURRENT image (gateway URL) so the picker shows it; only a
  // data: URL (a fresh upload) is ever sent to the server.
  let imageDataUrl = $state<string | null>(
    initial.imageHash ? `${BEE_GATEWAY}/bytes/${initial.imageHash}` : null,
  );

  let saving = $state(false);
  let error = $state<string | null>(null);
  let saved = $state(false);
  let deleting = $state(false);
  let deleteError = $state<string | null>(null);

  const deleteBlockedReason = $derived.by(() => {
    if (ordersCount > 0) return `${ordersCount} ticket(s) have been issued — events with orders can't be deleted.`;
    if (pendingCount > 0) return `${pendingCount} approval request(s) are pending — resolve them first.`;
    return null;
  });

  const imageChanged = $derived(imageDataUrl !== null && imageDataUrl.startsWith("data:"));

  const dateError = $derived.by(() => {
    const s = new Date(startDate).getTime();
    const e = new Date(endDate).getTime();
    if (isNaN(s) || isNaN(e)) return "Enter valid start and end dates.";
    if (e < s) return "End date is before the start date.";
    return null;
  });

  const canSave = $derived(!saving && title.trim().length > 0 && !dateError);

  function geoEqual(a: EventGeo | undefined, b: EventGeo | undefined): boolean {
    const norm = (g: EventGeo | undefined) => JSON.stringify(g ?? {}, Object.keys(g ?? {}).sort());
    return norm(a) === norm(b);
  }

  function tagsEqual(a: EventTag[], b: EventTag[]): boolean {
    const norm = (arr: EventTag[]) => arr.map((t) => `${t.type}:${t.value}`).sort().join("|");
    return norm(a) === norm(b);
  }

  function buildUpdates() {
    const updates: Pick<
      import("@woco/shared").UpdateEventMetaRequest,
      "title" | "tagline" | "description" | "startDate" | "endDate" | "location" | "geo" | "tags"
    > = {};
    if (title.trim() !== event.title) updates.title = title.trim();
    if (tagline.trim() !== (event.tagline ?? "")) updates.tagline = tagline.trim();
    if (description.trim() !== event.description) updates.description = description.trim();
    const startIso = new Date(startDate).toISOString();
    const endIso = new Date(endDate).toISOString();
    if (startIso !== new Date(event.startDate).toISOString()) updates.startDate = startIso;
    if (endIso !== new Date(event.endDate).toISOString()) updates.endDate = endIso;
    if (location.trim() !== event.location) updates.location = location.trim();
    if (!geoEqual(geo, event.geo)) updates.geo = geo ?? {};
    if (!tagsEqual(tags, event.tags ?? [])) updates.tags = tags;
    return updates;
  }

  async function save() {
    if (!canSave) return;
    saving = true;
    error = null;
    saved = false;
    try {
      const updates = buildUpdates();
      if (Object.keys(updates).length === 0 && !imageChanged) {
        error = "Nothing has changed.";
        return;
      }

      // Phase B: this event's feed is a client-owned SOC — the edit only becomes
      // visible once WE re-sign it, so fail loudly if the current account can't
      // produce the owning key (e.g. signed in as a different identity).
      let feedSigner: ContentFeedSigner | null = null;
      if (event.creatorFeedSigner) {
        feedSigner = await auth.getContentFeedSigner();
        if (!feedSigner || feedSigner.address.toLowerCase() !== event.creatorFeedSigner.toLowerCase()) {
          throw new Error(
            "This event's feed is owned by a different signing key than your current account — cannot save.",
          );
        }
      }

      const updated = await updateEventMeta(event.eventId, updates, {
        ...(imageChanged && imageDataUrl ? { image: imageDataUrl } : {}),
        // Route a replacement-image stamp to the event's own batch (Etherna vs WoCo).
        ...(event.gatewayUrl ? { gatewayUrl: event.gatewayUrl } : {}),
        feedSigner,
      });
      saved = true;
      if (updated) onsaved(updated);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to save changes";
    } finally {
      saving = false;
    }
  }

  async function handleDelete() {
    if (deleting || deleteBlockedReason) return;
    if (!confirm(`Delete "${event.title}"? This removes the event everywhere and cannot be undone.`)) return;
    deleting = true;
    deleteError = null;
    try {
      // Phase B feeds need the owning key to tombstone the SOC — same fail-loud
      // ownership check as save.
      let feedSigner: ContentFeedSigner | null = null;
      if (event.creatorFeedSigner) {
        feedSigner = await auth.getContentFeedSigner();
        if (!feedSigner || feedSigner.address.toLowerCase() !== event.creatorFeedSigner.toLowerCase()) {
          throw new Error(
            "This event's feed is owned by a different signing key than your current account — cannot delete.",
          );
        }
      }
      await deleteEvent(event.eventId, { feedSigner });
      ondeleted();
    } catch (e) {
      deleteError = e instanceof Error ? e.message : "Failed to delete event";
    } finally {
      deleting = false;
    }
  }
</script>

<div class="edit-panel">
  <p class="edit-note">
    Ticket tiers, pricing and supply are locked once published — they're committed
    on-chain. Everything below can be changed freely.
  </p>

  <ImageUpload bind:imageDataUrl onchange={(url) => (imageDataUrl = url)} />

  <div class="fields">
    <label>
      <span>Event title</span>
      <input type="text" bind:value={title} maxlength="200" />
    </label>

    <label>
      <span>Sub-heading <span class="hint">optional</span></span>
      <input type="text" bind:value={tagline} maxlength="120" placeholder="A one-line strapline shown below the title" />
    </label>

    <label>
      <span>Description</span>
      <textarea bind:value={description} rows="4"></textarea>
    </label>

    <div class="row">
      <label>
        <span>Start date</span>
        <input type="datetime-local" bind:value={startDate} />
      </label>
      <label>
        <span>End date</span>
        <input type="datetime-local" bind:value={endDate} />
      </label>
    </div>

    <label>
      <span>Location</span>
      <input type="text" bind:value={location} maxlength="300" />
    </label>
  </div>

  <LocationPicker bind:geo bind:location />
  <GenreTagPicker bind:tags />

  {#if dateError}
    <p class="field-error">{dateError}</p>
  {/if}
  {#if error}
    <p class="field-error">{error}</p>
  {/if}
  {#if saved && !error}
    <p class="save-ok">Changes saved. Attendee pages update within a minute or two.</p>
  {/if}

  <button class="btn btn--primary save-btn" onclick={save} disabled={!canSave}>
    {saving ? "Saving…" : "Save changes"}
  </button>

  <div class="danger-zone">
    <h3>Delete event</h3>
    {#if deleteBlockedReason}
      <p class="danger-hint">{deleteBlockedReason}</p>
    {:else}
      <p class="danger-hint">
        No tickets have been issued, so this event can still be deleted. It will be
        removed from listings and its page will stop resolving.
      </p>
    {/if}
    {#if deleteError}
      <p class="field-error">{deleteError}</p>
    {/if}
    <button
      class="delete-btn"
      onclick={handleDelete}
      disabled={deleting || !!deleteBlockedReason}
    >
      {deleting ? "Deleting…" : "Delete event"}
    </button>
  </div>
</div>

<style>
  .edit-panel {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    max-width: 560px;
  }

  .edit-note {
    font-size: 0.8125rem;
    color: var(--text-muted);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 0.75rem 1rem;
    margin: 0;
  }

  .fields {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  @media (max-width: 480px) {
    .row {
      grid-template-columns: 1fr;
    }
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  label span {
    color: var(--text-secondary);
    font-size: 0.8125rem;
    font-weight: 500;
  }

  .hint {
    color: var(--text-muted);
    font-weight: 400;
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-left: 0.375rem;
  }

  input[type="datetime-local"] {
    width: 100%;
    min-width: 0;
  }

  .field-error {
    color: var(--error);
    font-size: 0.8125rem;
    margin: 0;
  }

  .save-ok {
    color: var(--accent-text);
    font-size: 0.8125rem;
    margin: 0;
  }

  .save-btn {
    align-self: flex-start;
  }

  .save-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .danger-zone {
    margin-top: 1rem;
    border: 1px solid var(--error-subtle);
    border-radius: var(--radius-md);
    padding: 1rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .danger-zone h3 {
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--error);
  }

  .danger-hint {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0;
  }

  .delete-btn {
    align-self: flex-start;
    padding: 0.5rem 1.125rem;
    background: transparent;
    border: 1px solid var(--error);
    color: var(--error);
    border-radius: var(--radius-md);
    font-size: 0.8125rem;
    font-weight: 600;
    cursor: pointer;
    transition: background var(--transition);
  }

  .delete-btn:hover:not(:disabled) {
    background: var(--error-subtle);
  }

  .delete-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
