<script lang="ts">
  import type { OrderField, ClaimMode } from "@woco/shared";
  import { deriveEncryptionKeypairFromPodSeed, FEATURES } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { restorePodSeed } from "../../auth/pod-identity.js";
  import { buildEventManifests } from "../../pod/event-builder.js";
  import { publishEditions } from "../../pod/editions-publisher.js";
  import { createEventStreaming, registerSeriesOnChain, signEventFeedSoc, type PublishProgress } from "../../api/events.js";
  import { navigate } from "../../router/router.svelte.js";

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
    gate?: import("@woco/shared").PodGate;
  }

  interface Props {
    title: string;
    tagline?: string;
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
    /** Builder's selected gateway — routes event content to the Etherna batch
     *  when Etherna is chosen (the builder IS the event creator). */
    gatewayUrl?: string;
    onpublished?: (eventId: string) => void;
  }

  let {
    title, tagline, description, startDate, endDate, location,
    imageDataUrl, series, orderFields, claimMode,
    disabled = false, disabledReason,
    apiUrl, skipAutoList = false, label, gatewayUrl,
    onpublished,
  }: Props = $props();

  let publishing = $state(false);
  let error = $state<string | null>(null);
  let step = $state("");
  let progress = $state(0);
  let phase = $state<"auth" | "building" | "uploading" | "chain" | "done">("auth");

  // Authoritative date validation (the input `min` attrs are only a soft guard).
  // A past end date silently blocks ticket sales — the event reads as already
  // passed — so we refuse to publish one. Returns a message when invalid, else null.
  const dateError = $derived.by(() => {
    if (!startDate || !endDate) return null; // empty handled by canPublish below
    const s = new Date(startDate).getTime();
    const e = new Date(endDate).getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e)) return "Enter valid start and end dates.";
    if (e <= s) return "End date must be after the start date.";
    if (e <= Date.now()) return "End date must be in the future.";
    return null;
  });

  const canPublish = $derived(
    title.trim() &&
    startDate &&
    endDate &&
    !dateError &&
    imageDataUrl &&
    series.length > 0 &&
    series.every((s) => s.name.trim() && s.totalSupply > 0) &&
    // When free events are disabled, every series must carry a price > 0.
    (FEATURES.freeEventsAllowed || series.every((s) => s.payment && parseFloat(s.payment.price) > 0))
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

      // Derive encryption keypair (no extra popup)
      let encryptionKey: string | undefined;
      const podSeed = auth.podAddress ? await restorePodSeed(auth.podAddress) : null;
      if (podSeed) {
        encryptionKey = deriveEncryptionKeypairFromPodSeed(podSeed).publicKeyHex;
      }

      const keypair = await auth.getPodKeypair();
      if (!keypair) { error = "Could not get signing key"; return; }

      const organiserNonce = 0n;
      progress = 8;

      // Convert the datetime-local picker values (local wall-clock, no zone) to
      // absolute UTC instants for storage. This is what makes dates unambiguous:
      // the server reads the same instant regardless of its own timezone, and
      // every viewer's `toLocaleString()` then renders it in their local zone.
      // canPublish already guaranteed both dates are valid + in the future.
      const startDateIso = new Date(startDate).toISOString();
      const endDateIso = new Date(endDate).toISOString();

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
        eventMeta: { startDate: startDateIso, endDate: endDateIso, location },
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

      // Phase B: the event feed is ALWAYS client-owned. We never platform-sign an
      // event feed — the platform signer's only job now is the WoCo directory entry.
      // `apiUrl` (the same default API the server stamps against) and `skipAutoList`
      // (the "don't list on WoCo" opt-out) are DIRECTORY concerns, not signing ones;
      // neither must gate signing. Only kinds holding a deterministic raw key
      // (passkey/web3auth/local) return a signer today; web3/coinbase return null
      // until they get a feed-signer path, and the server legacy-writes those.
      const feedSigner = await auth.getContentFeedSigner();

      const result = await createEventStreaming(
        {
          event: { title, ...(tagline ? { tagline } : {}), description, startDate: startDateIso, endDate: endDateIso, location },
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
            ...(s.gate ? { gate: s.gate } : {}),
          })),
          image: imageDataUrl!,
          creatorAddress: auth.parent as `0x${string}`,
          creatorPodKey: keypair.publicKeyHex,
          encryptionKey,
          orderFields: orderFields?.length ? orderFields : undefined,
          claimMode: claimMode && claimMode !== "wallet" ? claimMode : undefined,
          ...(skipAutoList ? { skipAutoList: true } : {}),
          ...(gatewayUrl ? { gatewayUrl } : {}),
        },
        handleProgress,
        apiUrl,
        feedSigner,
      );

      if (!result.ok) {
        error = result.error || "Failed to publish event";
        return;
      }

      const eventId = result.eventId!;
      progress = 90;

      // ── Publish client-owned editions feed ────────────────────────────
      // The editions feed (woco/pod/editions/{seriesId}) is what reserve / claim /
      // Stripe read to allocate a ticket slot. It is a SOC OWNED BY THE CARRIER —
      // this browser builds + signs it; the server holds no key for it. Without it
      // every claim path throws "Series not found" (reserve + Stripe checkout +
      // email claim all break). Critical path: a failure here fails the publish.
      // Only the client-owned (feedSigner) path applies; legacy platform events
      // (web3/coinbase, no feedSigner) fall back to their existing behaviour.
      if (feedSigner && result.eventFeed) {
        phase = "uploading";
        step = "Publishing tickets...";
        try {
          await publishEditions({
            eventId,
            imageHash: result.eventFeed.imageHash,
            creatorAddress: result.eventFeed.creatorAddress,
            podPrivateKey: keypair.privateKey,
            podPublicKeyHex: keypair.publicKeyHex,
            feedSigner,
            ...(gatewayUrl ? { gatewayUrl } : {}),
            series: series.map((s) => ({
              seriesId: s.seriesId,
              name: s.name,
              totalSupply: s.totalSupply,
              ...(s.approvalRequired ? { approvalRequired: true } : {}),
            })),
            onProgress: (done, total) => { step = `Publishing tickets ${done}/${total}...`; },
          });
        } catch (e) {
          error = `Failed to publish tickets: ${e instanceof Error ? e.message : String(e)}`;
          return;
        }
      }

      // ── On-chain registration (paid series only) ──────────────────────
      // The server runs the registration tx and returns onChainEventId; it does
      // NOT write the event feed. For a client-owned feed the OWNER merges each
      // onChainEventId into the feed it signed and re-signs the SOC once here.
      if (hasPaidSeries) {
        phase = "chain";
        // The feed we just signed (Phase B); undefined for legacy platform events.
        const ownedFeed = result.eventFeed;
        for (let i = 0; i < series.length; i++) {
          const s = series[i]!;
          if (!s.payment) continue; // skip free series

          step = `Registering "${s.name}" on-chain...`;

          try {
            const { onChainEventId } = await registerSeriesOnChain(eventId, s.seriesId, feedSigner?.address);
            if (ownedFeed) {
              const ss = ownedFeed.series.find((x) => x.seriesId === s.seriesId);
              if (ss) ss.onChainEventId = onChainEventId;
            }
          } catch (e) {
            error = `On-chain registration failed for "${s.name}": ${e instanceof Error ? e.message : String(e)}`;
            return;
          }
        }
        // Persist the merged onChainEventIds by re-signing the owned feed once.
        if (ownedFeed && feedSigner) {
          step = "Finalising event feed...";
          try {
            await signEventFeedSoc(ownedFeed, feedSigner);
          } catch (e) {
            error = `Failed to finalise event feed: ${e instanceof Error ? e.message : String(e)}`;
            return;
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
        Registering your event on-chain — this can take a few seconds…
      {:else}
        Done!
      {/if}
    </p>
  {/if}

  {#if disabled && disabledReason && !publishing}
    <p class="hint">{disabledReason}</p>
  {:else if dateError && !publishing}
    <p class="hint">{dateError}</p>
  {:else if !canPublish && !publishing}
    <p class="hint">Fill in all required fields to publish</p>
  {/if}

  {#if error}
    {#if error.includes("Complete Stripe account setup")}
      <div class="stripe-gate">
        <div class="stripe-gate-body">
          <svg class="stripe-gate-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.4"/>
            <path d="M8 5v4M8 11v.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
          <div>
            <p class="stripe-gate-title">Stripe not connected</p>
            <p class="stripe-gate-sub">Connect a Stripe account to accept card payments before publishing.</p>
          </div>
        </div>
        <button class="stripe-gate-btn" onclick={() => navigate("/creator")}>Set up Stripe →</button>
      </div>
    {:else}
      <p class="error">{error}</p>
    {/if}
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

  .stripe-gate {
    padding: 0.75rem;
    background: color-mix(in srgb, var(--accent, #C7F23A) 7%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent, #C7F23A) 25%, transparent);
    border-radius: var(--radius-sm, 8px);
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .stripe-gate-body {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
  }

  .stripe-gate-icon {
    flex-shrink: 0;
    margin-top: 0.1em;
    color: var(--accent, #C7F23A);
    opacity: 0.9;
  }

  .stripe-gate-title {
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text);
  }

  .stripe-gate-sub {
    margin: 0.125rem 0 0;
    font-size: 0.75rem;
    color: var(--text-muted);
    line-height: 1.4;
  }

  .stripe-gate-btn {
    align-self: flex-start;
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
    font-weight: 600;
    background: var(--accent, #C7F23A);
    color: var(--accent-ink, #0a0a0a);
    border-radius: var(--radius-sm, 8px);
    transition: opacity 0.14s;
  }

  .stripe-gate-btn:hover { opacity: 0.85; }
</style>
