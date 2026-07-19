<script lang="ts">
  /**
   * Full-screen scan surface. Each decoded QR gets a verdict card + full-bleed
   * colour flash + sound/vibration; identical payloads are debounced so a
   * ticket held in frame doesn't re-trigger.
   */
  import { scanner, type ScanOutcome } from "./store.svelte.js";
  import { armAudio, feedbackSuccess, feedbackDuplicate, feedbackInvalid } from "./feedback.js";
  import QrCamera from "./QrCamera.svelte";

  const REARM_MS = 3000;
  const CARD_MS = 2600;

  let outcome = $state<ScanOutcome | null>(null);
  let manualValue = $state("");
  let showManual = $state(false);
  let busy = false;
  let lastPayload = "";
  let lastPayloadAt = 0;
  let cardTimer: ReturnType<typeof setTimeout> | null = null;

  function formatTime(iso: string): string {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return iso;
    }
  }

  async function handlePayload(raw: string): Promise<void> {
    const now = Date.now();
    if (busy || (raw === lastPayload && now - lastPayloadAt < REARM_MS)) return;
    busy = true;
    lastPayload = raw;
    lastPayloadAt = now;

    const result = await scanner.scan(raw);
    // Ignore stray non-ticket QRs entirely — flashing red at a poster QR in
    // the background would train staff to distrust real rejections.
    if (result.kind === "unreadable") {
      busy = false;
      return;
    }

    if (result.kind === "checked-in") feedbackSuccess();
    else if (result.kind === "duplicate") feedbackDuplicate();
    else feedbackInvalid();

    outcome = result;
    if (cardTimer) clearTimeout(cardTimer);
    cardTimer = setTimeout(() => (outcome = null), CARD_MS);
    busy = false;
  }

  function submitManual(): void {
    const value = manualValue.trim();
    if (!value) return;
    armAudio();
    void handlePayload(value);
    manualValue = "";
  }

  function dismiss(): void {
    if (cardTimer) clearTimeout(cardTimer);
    outcome = null;
  }
</script>

<svelte:window onpointerdown={armAudio} />

<div class="scan-screen">
  <QrCamera onScan={(data) => void handlePayload(data)} />

  {#if outcome}
    {@const kind = outcome.kind}
    <button
      class="verdict"
      class:ok={kind === "checked-in"}
      class:dup={kind === "duplicate"}
      class:bad={kind === "rejected" || kind === "wrong-event"}
      onclick={dismiss}
    >
      {#if outcome.kind === "checked-in"}
        <span class="verdict-title">CHECKED IN</span>
        {#if outcome.attendee?.name || outcome.attendee?.email}
          <span class="verdict-who">{outcome.attendee.name ?? outcome.attendee.email}</span>
        {/if}
        <span class="verdict-detail">{outcome.seriesName} · #{String(outcome.edition).padStart(3, "0")}</span>
        <span class="verdict-badge">
          {outcome.strength === "onchain" ? "✓ on-chain signature verified" : "✓ claim-ledger verified"}
        </span>
      {:else if outcome.kind === "duplicate"}
        <span class="verdict-title">ALREADY IN</span>
        {#if outcome.attendee?.name || outcome.attendee?.email}
          <span class="verdict-who">{outcome.attendee.name ?? outcome.attendee.email}</span>
        {/if}
        <span class="verdict-detail">
          #{String(outcome.edition).padStart(3, "0")} · {formatTime(outcome.record.at)}
          {outcome.record.method === "manual" ? " (manual)" : ""}
        </span>
      {:else if outcome.kind === "rejected"}
        <span class="verdict-title">INVALID</span>
        <span class="verdict-detail">{outcome.reason}</span>
      {:else if outcome.kind === "wrong-event"}
        <span class="verdict-title">WRONG EVENT</span>
        <span class="verdict-detail">This ticket belongs to a different event</span>
      {/if}
    </button>
  {/if}

  <div class="manual" class:open={showManual}>
    {#if showManual}
      <form
        class="manual-row"
        onsubmit={(e) => {
          e.preventDefault();
          submitManual();
        }}
      >
        <input
          bind:value={manualValue}
          placeholder="Paste ticket link or woco://t/… code"
          autocapitalize="off"
          autocomplete="off"
          spellcheck="false"
        />
        <button type="submit" class="manual-go">Check</button>
      </form>
    {/if}
    <button class="manual-toggle" onclick={() => (showManual = !showManual)}>
      {showManual ? "Hide manual entry" : "Type code manually"}
    </button>
  </div>
</div>

<style>
  .scan-screen {
    position: relative;
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .verdict {
    position: absolute;
    inset: 0;
    border: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 2rem 1.25rem;
    text-align: center;
    animation: pop 0.14s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(1.04);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }
  .verdict.ok {
    background: rgba(199, 242, 58, 0.94);
    color: var(--accent-ink);
  }
  .verdict.dup {
    background: rgba(255, 176, 32, 0.94);
    color: #1a1200;
  }
  .verdict.bad {
    background: rgba(255, 91, 44, 0.95);
    color: #fff;
  }
  .verdict-title {
    font-size: 2.25rem;
    font-weight: 800;
    letter-spacing: 0.04em;
  }
  .verdict-who {
    font-size: 1.375rem;
    font-weight: 700;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .verdict-detail {
    font-size: 1rem;
    font-weight: 500;
    opacity: 0.85;
  }
  .verdict-badge {
    margin-top: 0.5rem;
    font-family: var(--font-mono);
    font-size: 0.75rem;
    padding: 0.3rem 0.65rem;
    border-radius: var(--radius-sm);
    background: rgba(0, 0, 0, 0.18);
  }
  .manual {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    background: linear-gradient(transparent, rgba(11, 11, 9, 0.9) 40%);
  }
  .manual-row {
    display: flex;
    gap: 0.5rem;
  }
  .manual input {
    flex: 1;
    min-width: 0;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text);
    padding: 0.65rem 0.75rem;
    font-size: 0.9375rem;
  }
  .manual input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .manual-go {
    background: var(--accent);
    color: var(--accent-ink);
    border: none;
    border-radius: var(--radius-md);
    font-weight: 700;
    padding: 0 1rem;
  }
  .manual-toggle {
    align-self: center;
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 0.8125rem;
    padding: 0.35rem 0.75rem;
    text-decoration: underline;
  }
</style>
