<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import { claimTicket, getClaimStatus } from "../../api/events.js";
  import type { SeriesClaimStatus } from "@woco/shared";
  import { onMount } from "svelte";

  interface Props {
    eventId: string;
    seriesId: string;
    totalSupply: number;
  }

  let { eventId, seriesId, totalSupply }: Props = $props();

  let status = $state<SeriesClaimStatus | null>(null);
  let claiming = $state(false);
  let error = $state<string | null>(null);
  let step = $state("");
  let claimed = $state(false);
  let claimedEdition = $state<number | null>(null);

  onMount(async () => {
    try {
      const userAddr = auth.isAuthenticated ? auth.parent : undefined;
      status = await getClaimStatus(eventId, seriesId, userAddr || undefined);
      if (status?.userEdition != null) {
        claimed = true;
        claimedEdition = status.userEdition;
      }
    } catch {
      // Status check failed, button still shows
    }
  });

  async function handleClaim() {
    if (claiming) return;
    claiming = true;
    error = null;

    try {
      // Ensure wallet connected (one popup)
      if (!auth.isAuthenticated) {
        step = "Connecting wallet...";
        const ok = await auth.login();
        if (!ok) { error = "Login cancelled"; return; }
      }

      step = "Claiming ticket...";
      const result = await claimTicket(eventId, seriesId, auth.parent!);

      if (!result.ok) {
        error = result.error || "Failed to claim ticket";
        return;
      }

      claimed = true;
      claimedEdition = result.edition ?? null;
      step = "";

      // Refresh status
      const userAddr = auth.parent || undefined;
      status = await getClaimStatus(eventId, seriesId, userAddr);
    } catch (e) {
      error = e instanceof Error ? e.message : "Unexpected error";
    } finally {
      claiming = false;
    }
  }
</script>

<div class="claim-area">
  {#if claimed}
    <div class="claimed-badge">
      <span class="check">&#10003;</span>
      Claimed {#if claimedEdition != null}#{claimedEdition}{/if}
    </div>
  {:else}
    <button
      class="claim-btn"
      onclick={handleClaim}
      disabled={claiming || (status?.available === 0)}
    >
      {#if claiming}
        {step}
      {:else if status?.available === 0}
        Sold out
      {:else}
        Claim ticket
      {/if}
    </button>
  {/if}

  {#if status && !claimed}
    <span class="availability">
      {status.available} / {status.totalSupply} available
    </span>
  {/if}

  {#if error}
    <p class="error">{error}</p>
  {/if}
</div>

<style>
  .claim-area {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.375rem;
  }

  .claim-btn {
    padding: 0.5rem 1.25rem;
    font-size: 0.8125rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: #fff;
    white-space: nowrap;
    transition: background var(--transition);
  }

  .claim-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .claim-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .claimed-badge {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--success);
    border: 1px solid var(--success);
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }

  .check {
    font-size: 0.875rem;
  }

  .availability {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .error {
    color: var(--error);
    font-size: 0.75rem;
    margin: 0;
    text-align: right;
  }
</style>
