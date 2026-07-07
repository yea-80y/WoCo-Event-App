<script lang="ts">
  /**
   * Unprovisioned state: accept a door pass by scanning its QR (shown on the
   * organiser's dashboard) or pasting the pass link.
   */
  import { parseDoorPassFragment } from "@woco/shared";
  import { scanner } from "./store.svelte.js";
  import QrCamera from "./QrCamera.svelte";

  let pasted = $state("");
  let localError = $state<string | null>(null);
  let handling = false;

  function extractFragment(raw: string): { token: string; keyB64url: string } | null {
    const trimmed = raw.trim();
    const direct = parseDoorPassFragment(trimmed.startsWith("#") ? trimmed : `#${trimmed}`);
    if (direct) return direct;
    try {
      return parseDoorPassFragment(new URL(trimmed).hash);
    } catch {
      return null;
    }
  }

  async function accept(raw: string): Promise<void> {
    if (handling) return;
    handling = true;
    localError = null;
    const fragment = extractFragment(raw);
    if (!fragment) {
      localError = "That's not a WoCo door pass. Ask the organiser for the pass QR or link.";
      handling = false;
      return;
    }
    await scanner.provision(fragment.token, fragment.keyB64url);
    handling = false;
  }
</script>

<div class="provision">
  <header>
    <h1><span class="brand-a">WOCO</span><span class="brand-b">SCAN</span></h1>
    <p>Scan the <strong>door pass</strong> from the organiser's dashboard to set this device up for an event.</p>
  </header>

  <div class="cam">
    <QrCamera onScan={(data) => void accept(data)} paused={scanner.phase === "provisioning"} />
    {#if scanner.phase === "provisioning"}
      <div class="busy">Setting up — downloading event data…</div>
    {/if}
  </div>

  <form
    class="paste"
    onsubmit={(e) => {
      e.preventDefault();
      void accept(pasted);
    }}
  >
    <input bind:value={pasted} placeholder="…or paste the pass link here" autocapitalize="off" spellcheck="false" />
    <button type="submit">Go</button>
  </form>

  {#if localError || scanner.provisionError}
    <p class="error">{localError ?? scanner.provisionError}</p>
  {/if}
</div>

<style>
  .provision {
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 1.25rem;
    gap: 1rem;
  }
  header h1 {
    margin: 0 0 0.5rem;
    font-size: 1.5rem;
    letter-spacing: 0.06em;
  }
  .brand-a {
    color: var(--text);
  }
  .brand-b {
    color: var(--accent);
  }
  header p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.9375rem;
    line-height: 1.45;
  }
  .cam {
    position: relative;
    flex: 1;
    min-height: 220px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .busy {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(11, 11, 9, 0.85);
    color: var(--accent);
    font-weight: 600;
  }
  .paste {
    display: flex;
    gap: 0.5rem;
  }
  .paste input {
    flex: 1;
    min-width: 0;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text);
    padding: 0.7rem 0.85rem;
    font-size: 0.9375rem;
  }
  .paste input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .paste button {
    background: var(--accent);
    color: var(--accent-ink);
    border: none;
    border-radius: var(--radius-md);
    font-weight: 700;
    padding: 0 1.1rem;
  }
  .error {
    margin: 0;
    color: var(--error);
    font-size: 0.875rem;
  }
</style>
