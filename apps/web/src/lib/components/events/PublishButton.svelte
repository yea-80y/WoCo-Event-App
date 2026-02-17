<script lang="ts">
  import type { SignedTicket, OrderField } from "@woco/shared";
  import { deriveEncryptionKeypairFromPodSeed } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { restorePodSeed } from "../../auth/pod-identity.js";
  import { createSeriesTickets } from "../../pod/signing.js";
  import { createEventStreaming, type PublishProgress } from "../../api/events.js";

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
    /** Order form fields — undefined means no info collection */
    orderFields?: OrderField[];
    onpublished?: (eventId: string) => void;
  }

  let {
    title, description, startDate, endDate, location,
    imageDataUrl, series, orderFields, onpublished,
  }: Props = $props();

  let publishing = $state(false);
  let error = $state<string | null>(null);
  let step = $state("");
  let progress = $state(0); // 0-100
  let phase = $state<"auth" | "signing" | "uploading" | "done">("auth");

  const canPublish = $derived(
    title.trim() &&
    startDate &&
    endDate &&
    imageDataUrl &&
    series.length > 0 &&
    series.every((s) => s.name.trim() && s.totalSupply > 0)
  );

  const totalTickets = $derived(
    series.reduce((sum, s) => sum + s.totalSupply, 0)
  );

  function handleProgress(p: PublishProgress) {
    step = p.message;
    phase = "uploading";
    if (p.phase === "tickets" && p.total > 0) {
      // Tickets are the bulk of the work (~80% of progress)
      // Reserve 0-10% for auth/signing, 10-90% for tickets, 90-100% for feeds
      progress = 10 + Math.round((p.current / p.total) * 80);
    } else if (p.phase === "feeds") {
      progress = 90 + Math.round((p.current / Math.max(p.total, 1)) * 8);
    } else if (p.phase === "finalize") {
      progress = p.current > 0 ? 100 : 98;
    } else if (p.phase === "image") {
      progress = 10;
    }
  }

  async function handlePublish() {
    if (!canPublish || publishing) return;
    publishing = true;
    error = null;
    progress = 0;
    phase = "auth";

    try {
      // Step 1: Ensure user is connected (wallet or local account)
      if (!auth.isConnected) {
        step = "Waiting for sign-in...";
        const ok = await loginRequest.request();
        if (!ok) { error = "Login cancelled"; return; }
      }
      progress = 1;

      // Step 2: Ensure session delegation (EIP-712 — deferred until now)
      if (!auth.hasSession) {
        step = "Approve session delegation (1 of 2)...";
        const ok = await auth.ensureSession();
        if (!ok) { error = "Session delegation cancelled"; return; }
      }
      progress = 2;

      // Step 3: Ensure POD identity (EIP-712 — deferred until now)
      if (!auth.hasPodIdentity) {
        step = "Approve identity derivation (2 of 2)...";
        const pk = await auth.ensurePodIdentity();
        if (!pk) { error = "Identity setup cancelled"; return; }
      }
      progress = 4;

      // Derive encryption keypair from POD seed (zero extra popups)
      let encryptionKey: string | undefined;
      const podSeed = await restorePodSeed();
      if (podSeed) {
        const encKeypair = deriveEncryptionKeypairFromPodSeed(podSeed);
        encryptionKey = encKeypair.publicKeyHex;
      }

      phase = "signing";
      step = "Preparing tickets...";
      const keypair = await auth.getPodKeypair();
      if (!keypair) { error = "Could not get signing key"; return; }

      const signedTickets: Record<string, SignedTicket[]> = {};
      let signed = 0;
      for (const s of series) {
        signedTickets[s.seriesId] = await createSeriesTickets({
          eventId: "",
          seriesId: s.seriesId,
          seriesName: s.name,
          totalSupply: s.totalSupply,
          imageHash: "",
          creatorPrivateKey: keypair.privateKey,
          creatorPublicKeyHex: keypair.publicKeyHex,
        });
        signed += s.totalSupply;
        step = `Signing tickets (${signed}/${totalTickets})...`;
        progress = 4 + Math.round((signed / totalTickets) * 6);
      }

      phase = "uploading";
      step = "Publishing to Swarm...";
      progress = 10;

      const result = await createEventStreaming(
        {
          event: { title, description, startDate, endDate, location },
          series,
          signedTickets,
          image: imageDataUrl!,
          creatorAddress: auth.parent as `0x${string}`,
          creatorPodKey: auth.podPublicKeyHex!,
          encryptionKey,
          orderFields: orderFields?.length ? orderFields : undefined,
        },
        handleProgress,
      );

      if (!result.ok) {
        error = result.error || "Failed to publish event";
        return;
      }

      phase = "done";
      progress = 100;
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

  {#if publishing}
    <div class="progress-container">
      <div class="progress-bar" style="width: {progress}%"></div>
    </div>
    <p class="progress-label">
      {#if phase === "auth"}
        Setting up auth...
      {:else if phase === "signing"}
        Signing tickets locally...
      {:else if phase === "uploading"}
        Uploading to Swarm ({progress}%)
      {:else}
        Done!
      {/if}
    </p>
  {/if}

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
    font-size: 0.9375rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: #fff;
    transition: background var(--transition);
  }

  .publish-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .publish-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .progress-container {
    height: 6px;
    background: var(--bg-input);
    border-radius: 3px;
    overflow: hidden;
  }

  .progress-bar {
    height: 100%;
    background: var(--accent);
    border-radius: 3px;
    transition: width 0.3s ease;
    min-width: 0;
  }

  .progress-label {
    color: var(--text-secondary);
    font-size: 0.8125rem;
    text-align: center;
    margin: 0;
  }

  .hint {
    color: var(--text-muted);
    font-size: 0.8125rem;
    text-align: center;
    margin: 0;
  }

  .error {
    color: var(--error);
    font-size: 0.875rem;
    text-align: center;
    margin: 0;
  }
</style>
