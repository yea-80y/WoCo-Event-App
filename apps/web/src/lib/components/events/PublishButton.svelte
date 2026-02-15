<script lang="ts">
  import type { SignedTicket } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { createSeriesTickets } from "../../pod/signing.js";
  import { createEvent } from "../../api/events.js";

  interface SeriesDraft {
    seriesId: string;
    name: string;
    description: string;
    totalSupply: number;
  }

  interface Props {
    title: string;
    description: string;
    startDate: string;
    endDate: string;
    location: string;
    imageDataUrl: string | null;
    series: SeriesDraft[];
    onpublished?: (eventId: string) => void;
  }

  let {
    title, description, startDate, endDate, location,
    imageDataUrl, series, onpublished,
  }: Props = $props();

  let publishing = $state(false);
  let error = $state<string | null>(null);
  let step = $state("");

  const canPublish = $derived(
    title.trim() &&
    startDate &&
    endDate &&
    imageDataUrl &&
    series.length > 0 &&
    series.every((s) => s.name.trim() && s.totalSupply > 0 && s.totalSupply <= 127)
  );

  async function handlePublish() {
    if (!canPublish || publishing) return;
    publishing = true;
    error = null;

    try {
      // Step 1: Authenticate (if not already)
      if (!auth.isAuthenticated) {
        step = "Connecting wallet...";
        const ok = await auth.login();
        if (!ok) { error = "Login cancelled"; return; }
      }

      // Step 2: Ensure POD identity (for signing tickets)
      if (!auth.hasPodIdentity) {
        step = "Creating POD identity...";
        const pk = await auth.ensurePodIdentity();
        if (!pk) { error = "POD identity derivation cancelled"; return; }
      }

      // Step 3: Get keypair and sign all tickets
      step = "Signing tickets...";
      const keypair = await auth.getPodKeypair();
      if (!keypair) { error = "Could not get POD keypair"; return; }

      const signedTickets: Record<string, SignedTicket[]> = {};
      for (const s of series) {
        signedTickets[s.seriesId] = await createSeriesTickets({
          eventId: "", // Will be assigned by server
          seriesId: s.seriesId,
          seriesName: s.name,
          totalSupply: s.totalSupply,
          imageHash: "", // Will be assigned after upload
          creatorPrivateKey: keypair.privateKey,
          creatorPublicKeyHex: keypair.publicKeyHex,
        });
      }

      // Step 4: Upload to backend
      step = "Publishing to Swarm...";
      const result = await createEvent({
        event: { title, description, startDate, endDate, location },
        series,
        signedTickets,
        image: imageDataUrl!,
        creatorAddress: auth.parent as `0x${string}`,
        creatorPodKey: auth.podPublicKeyHex!,
      });

      if (!result.ok) {
        error = result.error || "Failed to publish event";
        return;
      }

      step = "Published!";
      onpublished?.(result.eventId!);
    } catch (e) {
      error = e instanceof Error ? e.message : "Unexpected error";
    } finally {
      publishing = false;
    }
  }
</script>

<div class="publish">
  <button
    class="publish-btn"
    onclick={handlePublish}
    disabled={!canPublish || publishing}
  >
    {#if publishing}
      {step}
    {:else}
      Publish Event
    {/if}
  </button>

  {#if !canPublish && !publishing}
    <p class="hint">Fill in all required fields to publish</p>
  {/if}

  {#if error}
    <p class="error">{error}</p>
  {/if}
</div>

<style>
  .publish {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.5rem;
  }

  .publish-btn {
    padding: 0.875rem;
    font-size: 1rem;
    font-weight: 600;
    border: none;
    border-radius: 8px;
    background: #4f46e5;
    color: #fff;
    cursor: pointer;
    transition: background 0.15s;
  }

  .publish-btn:hover:not(:disabled) {
    background: #4338ca;
  }

  .publish-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .hint {
    color: #6b7280;
    font-size: 0.8125rem;
    text-align: center;
    margin: 0;
  }

  .error {
    color: #ef4444;
    font-size: 0.875rem;
    text-align: center;
    margin: 0;
  }
</style>
