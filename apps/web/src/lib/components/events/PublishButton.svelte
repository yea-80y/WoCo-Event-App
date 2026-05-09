<script lang="ts">
  import type { OrderField, ClaimMode } from "@woco/shared";
  import { deriveEncryptionKeypairFromPodSeed } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { restorePodSeed } from "../../auth/pod-identity.js";
  import { buildEventManifests } from "../../pod/event-builder.js";
  import { createEventStreaming, getOrganiserNonce, confirmChainRegistration, type PublishProgress } from "../../api/events.js";
  import { callRegisterEvent } from "../../chain/woco-event.js";
  import { isWalletAvailable } from "../../wallet/provider.js";

  interface SeriesDraft {
    seriesId: string;
    name: string;
    description: string;
    totalSupply: number;
    approvalRequired?: boolean;
    wave?: string;
    saleStart?: string;
    saleEnd?: string;
    payment?: import("@woco/shared").PaymentConfig;
  }

  interface Props {
    title: string;
    description: string;
    startDate: string;
    endDate: string;
    location: string;
    imageDataUrl: string | null;
    series: SeriesDraft[];
    orderFields?: OrderField[];
    claimMode?: ClaimMode;
    disabled?: boolean;
    disabledReason?: string;
    apiUrl?: string;
    skipAutoList?: boolean;
    label?: string;
    onpublished?: (eventId: string) => void;
  }

  let {
    title, description, startDate, endDate, location,
    imageDataUrl, series, orderFields, claimMode,
    disabled = false, disabledReason,
    apiUrl, skipAutoList = false, label,
    onpublished,
  }: Props = $props();

  let publishing = $state(false);
  let error = $state<string | null>(null);
  let step = $state("");
  let progress = $state(0);
  let phase = $state<"auth" | "building" | "uploading" | "chain" | "done">("auth");

  const canPublish = $derived(
    title.trim() &&
    startDate &&
    endDate &&
    imageDataUrl &&
    series.length > 0 &&
    series.every((s) => s.name.trim() && s.totalSupply > 0)
  );

  const hasPaidSeries = $derived(series.some((s) => s.payment));

  function handleProgress(p: PublishProgress) {
    step = p.message;
    phase = "uploading";
    if (p.phase === "pods" && p.total > 0) {
      progress = 20 + Math.round((p.current / p.total) * 55);
    } else if (p.phase === "manifests") {
      progress = 75 + Math.round((p.current / Math.max(p.total, 1)) * 10);
    } else if (p.phase === "finalize") {
      progress = p.current > 0 ? 90 : 88;
    } else if (p.phase === "image") {
      progress = 20;
    }
  }

  async function handlePublish() {
    if (!canPublish || publishing || disabled) return;
    publishing = true;
    error = null;
    progress = 0;
    phase = "auth";

    try {
      // ── Auth ──────────────────────────────────────────────────────────
      if (!auth.isConnected) {
        step = "Waiting for sign-in...";
        const ok = await loginRequest.request();
        if (!ok) { error = "Login cancelled"; return; }
      }
      progress = 1;

      if (!auth.hasSession) {
        step = "Approve session (1 of 2)...";
        const ok = await auth.ensureSession();
        if (!ok) { error = "Session delegation cancelled"; return; }
      }
      progress = 2;

      if (!auth.hasPodIdentity) {
        step = "Approve identity (2 of 2)...";
        const pk = await auth.ensurePodIdentity();
        if (!pk) { error = "Identity setup cancelled"; return; }
      }
      progress = 4;

      // Check wallet availability for paid events (needed for registerEvent call)
      if (hasPaidSeries && !isWalletAvailable()) {
        error = "A browser wallet (MetaMask or WalletConnect) is required to register paid events on-chain";
        return;
      }

      // Derive encryption keypair (no extra popup)
      let encryptionKey: string | undefined;
      const podSeed = await restorePodSeed();
      if (podSeed) {
        encryptionKey = deriveEncryptionKeypairFromPodSeed(podSeed).publicKeyHex;
      }

      const keypair = await auth.getPodKeypair();
      if (!keypair) { error = "Could not get signing key"; return; }

      // ── Nonce fetch (paid events only — free events skip on-chain step) ──
      let organiserNonce = 0n;
      let chainId = 84532;
      if (hasPaidSeries) {
        step = "Fetching organiser nonce...";
        progress = 5;
        try {
          const nonceData = await getOrganiserNonce(auth.parent as string);
          organiserNonce = nonceData.nonce;
          chainId = nonceData.chainId;
        } catch (e) {
          error = "Failed to fetch organiser nonce from chain";
          return;
        }
      }
      progress = 8;

      // ── Build manifests ───────────────────────────────────────────────
      phase = "building";
      step = "Building manifests...";

      // Strip data: URL prefix to get raw base64, then upload image to get hash.
      // The image hash is embedded in pod metadata so it matches the event feed.
      // We pass an empty string if the image isn't available yet (rare edge case).
      const manifests = buildEventManifests({
        organiserAddress: (auth.parent as string).toLowerCase(),
        organiserNonce,
        creatorPodPrivateKey: keypair.privateKey,
        creatorPodPublicKeyHex: keypair.publicKeyHex,
        eventMeta: { startDate, endDate, location },
        series: series.map((s) => ({
          seriesId: s.seriesId,
          name: s.name,
          description: s.description,
          totalSupply: s.totalSupply,
        })),
      });
      progress = 15;

      // ── Upload to server ──────────────────────────────────────────────
      phase = "uploading";
      step = "Publishing to Swarm...";
      progress = 20;

      const result = await createEventStreaming(
        {
          event: { title, description, startDate, endDate, location },
          series: series.map((s, i) => ({
            seriesId: s.seriesId,
            name: s.name,
            description: s.description || "",
            totalSupply: s.totalSupply,
            signedManifest: manifests[i]!.signedManifest,
            podBodies: manifests[i]!.podBodies,
            ...(s.approvalRequired ? { approvalRequired: true } : {}),
            ...(s.wave ? { wave: s.wave } : {}),
            ...(s.saleStart ? { saleStart: s.saleStart } : {}),
            ...(s.saleEnd ? { saleEnd: s.saleEnd } : {}),
            ...(s.payment ? { payment: s.payment } : {}),
          })),
          image: imageDataUrl!,
          creatorAddress: auth.parent as `0x${string}`,
          creatorPodKey: keypair.publicKeyHex,
          encryptionKey,
          orderFields: orderFields?.length ? orderFields : undefined,
          claimMode: claimMode && claimMode !== "wallet" ? claimMode : undefined,
          ...(skipAutoList ? { skipAutoList: true } : {}),
        },
        handleProgress,
        apiUrl,
      );

      if (!result.ok) {
        error = result.error || "Failed to publish event";
        return;
      }

      const eventId = result.eventId!;
      progress = 90;

      // ── On-chain registration (paid series only) ──────────────────────
      if (hasPaidSeries) {
        phase = "chain";
        for (let i = 0; i < series.length; i++) {
          const s = series[i]!;
          if (!s.payment) continue; // skip free series

          const m = manifests[i]!;
          step = `Registering "${s.name}" on-chain...`;

          let txHash: string;
          let onChainEventId: string;
          try {
            ({ txHash, onChainEventId } = await callRegisterEvent(
              chainId,
              s.totalSupply,
              m.manifestDigestHex,
            ));
          } catch (e) {
            error = `Wallet tx failed for "${s.name}": ${e instanceof Error ? e.message : String(e)}`;
            return;
          }

          step = `Confirming "${s.name}" registration...`;
          try {
            await confirmChainRegistration(eventId, s.seriesId, onChainEventId, chainId);
          } catch (e) {
            // Non-fatal: event is already on Swarm; confirmation can be retried
            console.warn("[publish] confirm-chain failed (non-fatal):", e);
          }
        }
      }

      phase = "done";
      progress = 100;
      step = "Published!";
      onpublished?.(eventId);
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
    disabled={!canPublish || publishing || disabled}
  >
    {#if publishing}
      {step}
    {:else}
      {label ?? "Publish Event"}
    {/if}
  </button>

  {#if publishing}
    <div class="progress-container">
      <div class="progress-bar" style="width: {progress}%"></div>
    </div>
    <p class="progress-label">
      {#if phase === "auth"}
        Setting up auth...
      {:else if phase === "building"}
        Building manifests...
      {:else if phase === "uploading"}
        Uploading to Swarm ({progress}%)
      {:else if phase === "chain"}
        Registering on-chain...
      {:else}
        Done!
      {/if}
    </p>
  {/if}

  {#if disabled && disabledReason && !publishing}
    <p class="hint">{disabledReason}</p>
  {:else if !canPublish && !publishing}
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
