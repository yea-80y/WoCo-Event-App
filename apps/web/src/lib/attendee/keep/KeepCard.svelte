<!--
  KeepCard - one private ticket receipt on the Keep page (spec-receipt-note 5.2).

  Every network step is a button press: "Show my receipt" fetches and checks the box,
  "Save to your WoCo account" signs in, saves, reads back and THEN erases our copy,
  "Delete our copy" erases it again for a receipt already saved. Rendering reads only
  what the device already holds.

  Wording (spec 13a item 6): these are the ORDER'S KEYS, never "valid" - whether the
  tickets still stand is the verifier's question, against the chain. No "never" claims.
-->
<script lang="ts">
  import type { CheckedReceipt } from "@woco/shared/holding/open";
  import type { EraseResult } from "../../api/holdings.js";
  import type { DeviceReceipt } from "../../holding/device-store.js";
  import type { ShowResult } from "../../holding/keep-flow.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { navigate } from "../../router/router.svelte.js";

  let { receipt, fromLink = false, onchange }: { receipt: DeviceReceipt; fromLink?: boolean; onchange?: () => void } = $props();

  // svelte-ignore state_referenced_locally
  let kept = $state<DeviceReceipt>(receipt);
  let checked = $state<CheckedReceipt[] | null>(null);
  let busy = $state<"show" | "save" | "erase" | null>(null);
  let problem = $state<string | null>(null);
  let eraseNote = $state<EraseResult | null>(null);
  let unconfirmed = $state(false);

  const tickets = $derived(kept.box ? kept.box.receipts.map((e) => e.edition).sort((a, b) => a - b) : []);
  const savedHere = $derived(!!kept.savedTo && kept.savedTo === auth.parent?.toLowerCase());
  const eventId = $derived(kept.box?.receipts[0]?.wocoEventId ?? null);

  function short(addr: string): string {
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  }

  const SHOW_PROBLEM: Record<Exclude<ShowResult["kind"], "shown">, string> = {
    "not-found":
      "We couldn't find this receipt. If you already saved it to a WoCo account, it's there. Otherwise try again later - this device keeps your link.",
    later: "Couldn't load your receipt just now. Try again in a minute - this device keeps your link.",
    refused: "This receipt didn't check out, so it isn't shown or kept.",
    "unknown-ledger": "This receipt names a ticket system this app doesn't recognise, so it isn't shown.",
  };

  const ERASE_NOTE: Record<EraseResult, string> = {
    erased: "Our copy is deleted.",
    gone: "There was no copy of ours left to delete.",
    busy: "Our copy is still being stored, so it can't be deleted yet - try again in a minute.",
    refused: "We couldn't delete our copy: this device's clock looks wrong. Set the correct time, then try again.",
    later: "We couldn't delete our copy just now - try again later. Your receipt is safe in your account either way.",
  };

  async function refreshKept() {
    try {
      const got = await (await import("../../holding/device-store.js")).readDeviceReceipt(kept.pickupId);
      if (got) kept = got;
    } catch {
      /* keep what is shown */
    }
    onchange?.();
  }

  /** The event's public name, for display: from the cache, else one read of its public page. */
  async function loadTitle(rHex: string, id: string) {
    try {
      const [{ cacheGet, cacheKey }, device] = await Promise.all([
        import("../../cache/cache.js"),
        import("../../holding/device-store.js"),
      ]);
      let title = cacheGet<{ title?: string }>(cacheKey.event(id))?.title;
      if (!title) title = (await (await import("../../api/events.js")).getEvent(id))?.title;
      if (title) kept = await device.rememberDeviceTitle(rHex, title);
    } catch {
      /* the receipt stands without its event's name */
    }
  }

  async function show() {
    busy = "show";
    problem = null;
    try {
      const flow = await import("../../holding/keep-flow.js");
      const got = await flow.showReceipt(kept.pickupId, await flow.liveKeepFlowDeps());
      if (got.kind === "shown") {
        kept = got.receipt;
        checked = got.receipts;
        const first = got.receipt.box?.receipts[0];
        if (first && !got.receipt.title) void loadTitle(got.receipt.r, first.wocoEventId);
      } else {
        problem = SHOW_PROBLEM[got.kind];
      }
    } catch (e) {
      problem = e instanceof Error ? e.message : "Couldn't load your receipt - try again.";
    } finally {
      busy = null;
      onchange?.();
    }
  }

  async function save() {
    problem = null;
    eraseNote = null;
    unconfirmed = false;
    if (!auth.isConnected && !(await loginRequest.request({ context: "receipt" }))) return;
    busy = "save";
    let orderSecretKey: Uint8Array | null = null;
    try {
      if (!(await auth.ensureAccountSetup({ identity: true }))) {
        problem = "Your account isn't ready on this device yet - try again.";
        return;
      }
      // The CURRENT generation, confirmed (a passkey account's keys checked against the chain).
      const secrets = await auth.getAccountSecrets({ toSeal: true });
      const account = auth.parent?.toLowerCase();
      if (!secrets || !account) {
        problem = "Your account's keys aren't on this device - sign in again and retry.";
        return;
      }
      const [{ holdingGenKeysOf }, flow] = await Promise.all([
        import("../../holding/account-copy.js"),
        import("../../holding/keep-flow.js"),
      ]);
      const keys = await holdingGenKeysOf(secrets.current);
      orderSecretKey = keys.orderSecretKey;
      const out = await flow.saveToAccount(kept.pickupId, keys, account, await flow.liveKeepFlowDeps());
      if (out.kind === "saved") eraseNote = out.erase;
      else if (out.kind === "unconfirmed") unconfirmed = true;
      else problem = "Show your receipt first, then save it.";
    } catch (e) {
      problem = e instanceof Error ? e.message : "Couldn't save your receipt - try again.";
    } finally {
      orderSecretKey?.fill(0);
      busy = null;
      await refreshKept();
    }
  }

  async function eraseAgain() {
    busy = "erase";
    problem = null;
    try {
      const flow = await import("../../holding/keep-flow.js");
      const got = await flow.finishErase(kept.pickupId, await flow.liveKeepFlowDeps());
      if (got !== "not-saved") eraseNote = got;
    } catch (e) {
      problem = e instanceof Error ? e.message : "Couldn't delete our copy - try again.";
    } finally {
      busy = null;
      await refreshKept();
    }
  }
</script>

<article class="card" class:card--link={fromLink}>
  <header class="top">
    <span class="kicker">{fromLink ? "From your ticket email" : "On this device"}</span>
    <h2 class="name">{kept.title ?? (kept.box ? "Your tickets" : "Your private receipt")}</h2>
    {#if tickets.length > 0}
      <p class="meta">{tickets.length === 1 ? `Ticket ${tickets[0]}` : `Tickets ${tickets.join(", ")}`}</p>
    {/if}
  </header>

  {#if checked}
    <div class="keys">
      <p class="keys-title">Your order's keys</p>
      <p class="keys-note">Each ticket has its own key. Only your link opens them.</p>
      <ul class="keys-list">
        {#each checked as c (c.receipt.slot)}
          <li><span>Ticket {c.receipt.edition}</span><code>{short(c.receipt.holder)}</code></li>
        {/each}
      </ul>
    </div>
  {:else if !kept.box}
    <p class="body">Nothing has been loaded yet. Press the button to open your receipt.</p>
  {/if}

  {#if kept.savedTo}
    <p class="status status--ok">
      {savedHere ? "Saved in your WoCo account." : "Saved in a WoCo account."}
      {#if kept.serverErased}Our copy is deleted.{/if}
    </p>
  {/if}
  {#if unconfirmed}
    <p class="status">
      Sent to your account, but not confirmed yet. Try again in a moment - we keep our copy until it's confirmed.
    </p>
  {/if}
  {#if eraseNote && !(kept.serverErased && (eraseNote === "erased" || eraseNote === "gone"))}
    <p class="status">{ERASE_NOTE[eraseNote]}</p>
  {/if}
  {#if problem}
    <p class="problem" role="alert">{problem}</p>
  {/if}

  <div class="actions">
    {#if !checked}
      <button class="btn btn--ghost" disabled={busy !== null} onclick={show}>
        {busy === "show" ? "Opening…" : "Show my receipt"}
      </button>
    {/if}
    {#if checked && !savedHere}
      <button class="btn btn--primary" disabled={busy !== null} onclick={save}>
        {busy === "save" ? "Saving…" : "Save to your WoCo account"}
      </button>
    {/if}
    {#if savedHere && !kept.serverErased}
      <button class="btn btn--ghost" disabled={busy !== null} onclick={eraseAgain}>
        {busy === "erase" ? "Deleting…" : "Delete our copy"}
      </button>
    {/if}
    {#if eventId}
      <button class="btn btn--text" onclick={() => navigate(`/event/${eventId}`)}>See the event</button>
    {/if}
  </div>
</article>

<style>
  .card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 14px);
    padding: 1.25rem 1.125rem;
  }
  .card--link {
    border-color: var(--border-focus);
  }
  .top {
    margin-bottom: 0.75rem;
  }
  .kicker {
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .name {
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--text);
    margin: 0.25rem 0 0.125rem;
  }
  .meta,
  .body,
  .keys-note {
    font-size: 0.875rem;
    color: var(--text-secondary);
    line-height: 1.5;
    margin: 0;
  }
  .keys {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 0.75rem 0.875rem;
    margin: 0.5rem 0 0.75rem;
  }
  .keys-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text);
    margin: 0 0 0.125rem;
  }
  .keys-list {
    list-style: none;
    margin: 0.5rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .keys-list li {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }
  .keys-list code {
    font-family: ui-monospace, "SF Mono", "Cascadia Code", monospace;
    color: var(--text);
  }
  .status {
    font-size: 0.875rem;
    color: var(--text-secondary);
    line-height: 1.5;
    margin: 0.5rem 0 0;
  }
  .status--ok {
    color: var(--success);
  }
  .problem {
    font-size: 0.875rem;
    color: var(--text);
    background: var(--error-subtle);
    border: 1px solid color-mix(in srgb, var(--error) 35%, transparent);
    border-radius: var(--radius-md);
    padding: 0.625rem 0.875rem;
    line-height: 1.5;
    margin: 0.5rem 0 0;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.875rem;
  }
</style>
