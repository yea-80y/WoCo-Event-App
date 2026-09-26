<script lang="ts">
  /**
   * "Door" tab — sets up the scanner for an event and shows live check-in
   * counts. Generates the roster key CLIENT-SIDE, encrypts the decrypted
   * order data under it, and uploads only ciphertext; the key travels solely
   * in the door-pass URL fragment. Regenerating the pass rotates the server
   * jti and revokes every previously provisioned device.
   *
   * The organiser picks a door mode per pass (#641): one scanner, which works
   * with no signal because no other phone can use the pass, or several, where
   * every scan is confirmed with WoCo first so no ticket gets in twice.
   */
  import { onMount } from "svelte";
  import QRCode from "qrcode";
  import { buildDoorPassUrl, parseDoorPassFragment, type DoorMode, type RosterEntry } from "@woco/shared";
  import type { EventFeed, OrderEntry } from "@woco/shared";
  import { issueDoorPass, pushCheckinRoster, getCheckinStatus, type CheckinStatus } from "../../api/checkin.js";
  import { generateRosterKeyB64url, encryptRoster } from "../../scanner/roster-crypto.js";

  interface DecryptedOrder {
    fields?: Record<string, string>;
    seriesId?: string;
    claimerEmail?: string;
    claimerAddress?: string;
  }

  interface Props {
    eventId: string;
    event: EventFeed;
    orders: OrderEntry[];
    decryptedOrders: Map<number, DecryptedOrder>;
    decrypting: boolean;
    onEnsureDecrypted: () => Promise<void>;
  }

  let { eventId, event, orders, decryptedOrders, decrypting, onEnsureDecrypted }: Props = $props();

  const SCANNER_ORIGIN =
    import.meta.env.VITE_SCANNER_URL ||
    (import.meta.env.DEV ? "http://localhost:5175" : "https://scan.woco.eth.limo");

  interface StoredDoorPass {
    url: string;
    exp: number;
    /** Absent on passes stored before #641: the server treats those as "several". */
    mode?: DoorMode;
    rosterPushedAt?: string;
  }

  let stored = $state<StoredDoorPass | null>(null);
  let qrDataUrl = $state<string | null>(null);
  let working = $state(false);
  let workError = $state<string | null>(null);
  let copied = $state(false);
  let confirmRegen = $state(false);
  let confirmSwitch = $state(false);
  let mode = $state<DoorMode>("single");
  let status = $state<CheckinStatus | null>(null);

  const storageKey = $derived(`woco:doorpass:${eventId}`);
  const hasEncrypted = $derived(orders.some((o) => !!o.encryptedOrder));
  const needsDecrypt = $derived(hasEncrypted && decryptedOrders.size === 0);

  onMount(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) stored = JSON.parse(raw) as StoredDoorPass;
    } catch {
      stored = null;
    }
    if (stored && stored.exp * 1000 < Date.now()) stored = null;

    void refreshStatus();
    const timer = setInterval(() => void refreshStatus(), 15_000);
    return () => clearInterval(timer);
  });

  $effect(() => {
    if (!stored) {
      qrDataUrl = null;
      return;
    }
    QRCode.toDataURL(stored.url, { margin: 1, width: 480, color: { dark: "#0B0B09", light: "#F2EBE0" } })
      .then((url: string) => (qrDataUrl = url))
      .catch(() => (qrDataUrl = null));
  });

  async function refreshStatus(): Promise<void> {
    try {
      status = await getCheckinStatus(eventId);
    } catch {
      // Not fatal — counts just don't show.
    }
  }

  function buildRosterEntries(): RosterEntry[] {
    const seriesName = new Map(event.series.map((s) => [s.seriesId, s.name]));
    return orders.map((order, idx) => {
      const dec = decryptedOrders.get(idx);
      const fields = dec?.fields ?? undefined;
      const nameKey = fields ? Object.keys(fields).find((k) => /name/i.test(k)) : undefined;
      return {
        seriesId: order.seriesId,
        seriesName: seriesName.get(order.seriesId) ?? order.seriesName,
        edition: order.edition,
        name: nameKey ? fields![nameKey] : undefined,
        email: dec?.claimerEmail,
        fields,
      };
    });
  }

  /** First-time setup AND regenerate: new key + new pass (old devices die). */
  async function generatePass(passMode: DoorMode): Promise<void> {
    working = true;
    workError = null;
    confirmRegen = false;
    confirmSwitch = false;
    try {
      if (needsDecrypt) await onEnsureDecrypted();

      const keyB64url = generateRosterKeyB64url();
      const roster = await encryptRoster(buildRosterEntries(), keyB64url);
      await pushCheckinRoster(eventId, roster);

      const issued = await issueDoorPass(eventId, passMode);
      const url = buildDoorPassUrl(SCANNER_ORIGIN, issued.token, keyB64url);
      stored = { url, exp: issued.exp, mode: issued.mode, rosterPushedAt: new Date().toISOString() };
      localStorage.setItem(storageKey, JSON.stringify(stored));
    } catch (err) {
      workError = err instanceof Error ? err.message : "Setup failed";
    } finally {
      working = false;
    }
  }

  /** Re-push the roster under the EXISTING key so provisioned devices keep working. */
  async function refreshRoster(): Promise<void> {
    if (!stored) return;
    working = true;
    workError = null;
    try {
      if (needsDecrypt) await onEnsureDecrypted();
      const fragment = parseDoorPassFragment(new URL(stored.url).hash);
      if (!fragment) throw new Error("Stored pass is malformed — regenerate it");
      const roster = await encryptRoster(buildRosterEntries(), fragment.keyB64url);
      await pushCheckinRoster(eventId, roster);
      stored = { ...stored, rosterPushedAt: new Date().toISOString() };
      localStorage.setItem(storageKey, JSON.stringify(stored));
    } catch (err) {
      workError = err instanceof Error ? err.message : "Roster refresh failed";
    } finally {
      working = false;
    }
  }

  async function copyLink(): Promise<void> {
    if (!stored) return;
    try {
      await navigator.clipboard.writeText(stored.url);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      workError = "Could not copy — long-press the link to copy manually";
    }
  }

  function regenTap(): void {
    if (!confirmRegen) {
      confirmRegen = true;
      setTimeout(() => (confirmRegen = false), 4000);
      return;
    }
    void generatePass(stored?.mode ?? "several");
  }

  function switchTap(): void {
    if (!confirmSwitch) {
      confirmSwitch = true;
      setTimeout(() => (confirmSwitch = false), 4000);
      return;
    }
    void generatePass(stored?.mode === "single" ? "several" : "single");
  }

  function formatTime(iso: string): string {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return iso;
    }
  }
</script>

<div class="checkin-panel">
  {#if status && status.checkedIn > 0}
    <div class="live-counts">
      <div class="count-main">
        <span class="count-num">{status.checkedIn}</span>
        <span class="count-label">checked in{status.lastCheckinAt ? ` · last ${formatTime(status.lastCheckinAt)}` : ""}</span>
      </div>
      {#each event.series as s (s.seriesId)}
        {#if status.bySeries[s.seriesId]}
          <span class="count-series">{s.name}: {status.bySeries[s.seriesId]}</span>
        {/if}
      {/each}
    </div>
  {/if}

  {#if !stored}
    <div class="setup-card">
      <h3>Door scanner</h3>
      <p>
        Generate a <strong>door pass</strong> to turn any phone into a ticket scanner for this event -
        no login needed on the door device. The pass loads everything the scanner needs to check
        tickets, including your attendee list (encrypted - the WoCo server never sees names or emails).
      </p>
      <fieldset class="modes">
        <legend>How many phones on the door?</legend>
        <label class="mode" class:chosen={mode === "single"}>
          <input type="radio" name="door-mode" value="single" bind:group={mode} />
          <span class="mode-name">One scanner</span>
          <span class="mode-desc">Works with no signal. Only the first phone that opens the pass can use it.</span>
        </label>
        <label class="mode" class:chosen={mode === "several"}>
          <input type="radio" name="door-mode" value="several" bind:group={mode} />
          <span class="mode-name">Several scanners</span>
          <span class="mode-desc">For busy doors. Every phone needs signal: each scan is confirmed with WoCo first, so no ticket gets in twice.</span>
        </label>
      </fieldset>
      {#if needsDecrypt}
        <p class="hint">Your order data will be decrypted first — this may ask for your signature.</p>
      {/if}
      <button class="primary" onclick={() => void generatePass(mode)} disabled={working || decrypting}>
        {working ? "Setting up…" : "Generate door pass"}
      </button>
    </div>
  {:else}
    <div class="pass-card">
      <h3>Door pass</h3>
      {#if stored.mode === "single"}
        <p class="mode-line"><strong>One scanner</strong> - works with no signal. The first phone to open this pass is the only one that can use it.</p>
      {:else}
        <p class="mode-line"><strong>Several scanners</strong> - every phone needs signal, and each ticket is let in once across all of them.</p>
      {/if}
      <p class="hint">
        On the door {stored.mode === "single" ? "phone" : "phones"}, open <strong>{SCANNER_ORIGIN.replace(/^https?:\/\//, "")}</strong> and scan
        this QR (or open the link). Anyone with this pass can check people in - share it only with
        your door team.
      </p>
      {#if qrDataUrl}
        <img class="pass-qr" src={qrDataUrl} alt="Door pass QR" />
      {/if}
      <div class="pass-actions">
        <button onclick={() => void copyLink()}>{copied ? "Copied ✓" : "Copy pass link"}</button>
        <button onclick={() => void refreshRoster()} disabled={working || decrypting}>
          {working ? "Working…" : "Re-push attendee list"}
        </button>
        <button onclick={switchTap} disabled={working}>
          {confirmSwitch
            ? "Tap again - this makes a new pass and locks out every scanner"
            : stored.mode === "single" ? "Switch to several scanners" : "Switch to one scanner"}
        </button>
        <button class="danger" onclick={regenTap} disabled={working}>
          {confirmRegen
            ? stored.mode === "single" ? "Tap again - the old phone stops once it has signal" : "Tap again - this locks out every scanner"
            : stored.mode === "single" ? "Regenerate (move to another phone)" : "Regenerate (revoke all devices)"}
        </button>
      </div>
      {#if stored.mode === "single"}
        <p class="hint caution">
          Before you regenerate or switch, open the scanner on the old phone with signal and wait until it
          shows nothing unsynced. A phone that is offline when you do it keeps checking people in until it
          next gets signal - and the new pass does not know who it let in.
        </p>
      {/if}
      {#if stored.rosterPushedAt}
        <p class="meta">Attendee list pushed {new Date(stored.rosterPushedAt).toLocaleString()}</p>
      {/if}
      <p class="meta">Pass valid until {new Date(stored.exp * 1000).toLocaleString()}</p>
    </div>
  {/if}

  {#if workError}
    <p class="error">{workError}</p>
  {/if}
</div>

<style>
  .checkin-panel {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 560px;
  }
  .live-counts {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem 1rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 1rem 1.25rem;
  }
  .count-main {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .count-num {
    font-family: var(--font-mono);
    font-size: 2rem;
    font-weight: 700;
    color: var(--accent);
  }
  .count-label {
    color: var(--text-secondary);
    font-size: 0.875rem;
  }
  .count-series {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    color: var(--text-muted);
  }
  .setup-card,
  .pass-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 1.25rem;
  }
  h3 {
    margin: 0 0 0.5rem;
  }
  p {
    color: var(--text-secondary);
    font-size: 0.9375rem;
    line-height: 1.5;
    margin: 0 0 0.75rem;
  }
  .hint {
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .modes {
    border: none;
    margin: 0 0 1rem;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .modes legend {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 0.5rem;
  }
  .mode {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 0.6rem;
    row-gap: 0.15rem;
    align-items: center;
    padding: 0.75rem 0.85rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    cursor: pointer;
  }
  .mode.chosen {
    border-color: var(--accent);
    background: var(--accent-subtle);
  }
  .mode input {
    accent-color: var(--accent);
    margin: 0;
  }
  .mode-name {
    font-weight: 600;
    color: var(--text);
  }
  .mode-desc {
    grid-column: 2;
    font-size: 0.85rem;
    color: var(--text-secondary);
    line-height: 1.45;
  }
  .caution {
    margin: 0.75rem 0 0;
    color: var(--warning);
  }
  .mode-line {
    font-size: 0.875rem;
  }
  .pass-qr {
    display: block;
    width: 100%;
    max-width: 300px;
    margin: 0.5rem auto 1rem;
    border-radius: var(--radius-md);
  }
  .pass-actions {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  button {
    background: var(--bg-elevated);
    border: 1px solid var(--border-hover);
    border-radius: var(--radius-md);
    color: var(--text);
    font-weight: 600;
    font-size: 0.9375rem;
    padding: 0.65rem 1rem;
    transition: background var(--transition);
  }
  button:hover:not(:disabled) {
    background: var(--bg-surface-hover);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-ink);
  }
  button.primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }
  button.danger {
    color: var(--error);
    border-color: var(--error-subtle);
  }
  .meta {
    margin: 0.75rem 0 0;
    font-size: 0.78rem;
    color: var(--text-dim);
  }
  .error {
    color: var(--error);
    font-size: 0.875rem;
  }
</style>
