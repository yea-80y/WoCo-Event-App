<!--
  KeepPage - private ticket receipts kept on this device (`#/keep`), and the page a
  ticket email's "Keep my receipt" button opens (spec-receipt-note 5.2).

  INERT ON LOAD: the router already took the link's secret out of the address bar; this
  page only reads the link and this device's own storage when it opens. Nothing goes over
  the network until a button is pressed - mail scanners open links (Fable condition 2,
  test/holding-keep-page.test.ts).
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { onKeepLink, returnKeepLink, takeKeepLink } from "../../holding/keep-capture.js";
  import type { DeviceReceipt } from "../../holding/device-store.js";
  import KeepCard from "./KeepCard.svelte";

  let receipts = $state<DeviceReceipt[]>([]);
  /** The receipt this visit's link opened: shown first. */
  let fromLink = $state<string | null>(null);
  let malformed = $state(false);
  let loaded = $state(false);
  let storageFailed = $state(false);

  /** LOCAL ONLY: the link, and what this device already keeps. */
  async function loadLocal() {
    const fragment = takeKeepLink();
    try {
      const [{ acceptKeepLink }, device] = await Promise.all([
        import("../../holding/keep-flow.js"),
        import("../../holding/device-store.js"),
      ]);
      if (fragment) {
        const got = await acceptKeepLink(fragment, { device });
        // The latest link decides: a good one opened after a broken one clears the warning.
        malformed = got === "malformed";
        if (got !== "malformed") fromLink = got.pickupId;
      }
      receipts = await device.listDeviceReceipts();
      storageFailed = false;
    } catch {
      // Storage blocked (a private window, say): the link stays in memory for the
      // "Try again" button - put back quietly, or this page's own listener would loop.
      if (fragment) returnKeepLink(fragment);
      storageFailed = true;
    }
    loaded = true;
  }

  async function reload() {
    try {
      receipts = await (await import("../../holding/device-store.js")).listDeviceReceipts();
    } catch {
      /* the cards keep what they show */
    }
  }

  onMount(() => {
    void loadLocal();
    return onKeepLink(() => void loadLocal());
  });

  const ordered = $derived(
    fromLink
      ? [...receipts.filter((r) => r.pickupId === fromLink), ...receipts.filter((r) => r.pickupId !== fromLink)]
      : receipts,
  );
</script>

<div class="page">
  <header class="head">
    <h1 class="title">Private receipts</h1>
    <p class="lede">
      A private record of your order, that only your link opens. Save it to a free WoCo account to keep it.
    </p>
  </header>

  {#if !loaded}
    <p class="note">Opening…</p>
  {:else}
    {#if malformed}
      <p class="problem" role="alert">
        This link isn't complete. Open it again from your ticket email - copying it by hand can drop part of it.
      </p>
    {/if}
    {#if storageFailed}
      <p class="problem" role="alert">
        This browser won't let WoCo keep anything on this device - a private window can do this. Open the link in a
        normal window.
      </p>
      <button class="btn btn--ghost" onclick={() => void loadLocal()}>Try again</button>
    {:else if ordered.length === 0}
      {#if !malformed}
        <p class="note">
          No receipts on this device. Open <strong>Keep my receipt</strong> in your ticket email to see yours here.
        </p>
      {/if}
    {:else}
      <ul class="list">
        {#each ordered as receipt (receipt.pickupId)}
          <li><KeepCard {receipt} fromLink={receipt.pickupId === fromLink} onchange={reload} /></li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .page {
    max-width: 520px;
    margin: 0 auto;
    padding: 2rem 1rem 3rem;
  }
  .head {
    margin-bottom: 1.25rem;
  }
  .title {
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.015em;
    margin: 0 0 0.375rem;
  }
  .lede {
    font-size: 0.9375rem;
    color: var(--text-secondary);
    line-height: 1.5;
    margin: 0;
  }
  .note {
    font-size: 0.875rem;
    color: var(--text-secondary);
    line-height: 1.5;
  }
  .problem {
    font-size: 0.875rem;
    color: var(--text);
    background: color-mix(in srgb, var(--error) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--error) 35%, transparent);
    border-radius: var(--radius-md);
    padding: 0.75rem 1rem;
    line-height: 1.5;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }
</style>
