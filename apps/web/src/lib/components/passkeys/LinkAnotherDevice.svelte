<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import { apiBase } from "../../api/http.js";
  import type { PairingOffer } from "../../auth/device-link.js";

  /**
   * "Add another device" (#746), on any of the account's passkeys: read the code the
   * other device shows - with WoCo's own scanner or typed, never a phone's camera app -
   * then confirm with a passkey sheet every time, whatever the unlock window says. The
   * other device's passkey goes on the account's list: a co-owner like this one.
   */

  // `keys` (#186): opened from a passkey that needs the account's keys - its code
  // asks for them, and nothing is added to the account.
  let { onlinked, onclose, mode = "link" }: { onlinked: () => void; onclose: () => void; mode?: "link" | "keys" } = $props();

  let stage = $state<"scan" | "reading" | "confirm" | "working" | "done">("scan");
  let camera = $state(false);
  let typed = $state("");
  let error = $state<string | null>(null);
  let pending: { code: Uint8Array; offer: PairingOffer } | null = null;
  let gaveKeys = $state(false);
  // The code read asks for keys (#186), not to add a device.
  let keysRequest = $state(false);

  const loadCamera = () => import("../../scanner/QrCamera.svelte");

  // The camera reports the same code several times a second; one at a time.
  let inFlight = false;

  async function use(input: string): Promise<void> {
    if (stage !== "scan" || inFlight) return;
    inFlight = true;
    try {
      await read(input);
    } finally {
      inFlight = false;
    }
  }

  async function read(input: string): Promise<void> {
    const link = await import("../../auth/device-link.js");
    stage = "reading";
    error = null;
    try {
      pending = await link.readPairingOffer(input, { apiBase });
      keysRequest = pending.offer.kind === "keys";
      stage = "confirm";
    } catch (e) {
      error = e instanceof Error ? e.message : link.LINK_CODE_UNKNOWN;
      stage = "scan";
    }
  }

  function scanned(data: string): void {
    // Anything else the camera sees is not ours to complain about.
    if (data.trim().toLowerCase().startsWith("woco-pair:")) void use(data);
  }

  async function approve(): Promise<void> {
    if (stage !== "confirm" || !pending) return;
    stage = "working";
    error = null;
    try {
      if (pending.offer.kind === "keys") await auth.giveKeys(pending.code, pending.offer);
      else await auth.approveDeviceLink(pending.code, pending.offer);
      gaveKeys = pending.offer.kind === "keys";
      pending = null;
      stage = "done";
      onlinked();
    } catch (e) {
      error =
        e instanceof Error && e.name === "PasskeyCeremonyCancelledError"
          ? "Nothing was changed."
          : e instanceof Error
            ? e.message
            : "Nothing was changed.";
      stage = "confirm";
    }
  }
</script>

<div class="link">
  {#if (stage === "scan" || stage === "reading") && mode === "keys"}
    <p class="panel-title">Give it keys</p>
    <p>On the other device, open WoCo and tap Show the code. Scan the code it shows.</p>
  {:else if stage === "scan" || stage === "reading"}
    <p class="panel-title">Add another device</p>
    <p>
      Same password manager on both - like Google Password Manager on this phone and in Chrome on your laptop? Just sign
      in there. Nothing to add.
    </p>
    <p>Otherwise, on the other device open woco.eth.limo, tap Sign in, then Add this device. Scan the code it shows.</p>
  {/if}
  {#if stage === "scan" || stage === "reading"}
    {#if camera}
      {#await loadCamera() then { default: QrCamera }}
        <QrCamera onScan={scanned} paused={stage !== "scan"} />
      {/await}
    {:else}
      <button class="btn btn--primary" onclick={() => (camera = true)}>Scan the code</button>
    {/if}
    <form class="typed" onsubmit={(e) => { e.preventDefault(); void use(typed); }}>
      <input
        bind:value={typed}
        placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX"
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
        aria-label="Code from the other device"
      />
      <button class="btn btn--ghost" type="submit" disabled={stage !== "scan" || !typed.trim()}>
        {stage === "reading" ? "Checking…" : "Use code"}
      </button>
    </form>
    <button class="btn btn--ghost" onclick={onclose}>Not now</button>
  {:else if (stage === "confirm" || stage === "working") && keysRequest}
    <p class="panel-title">Give this passkey your account's keys?</p>
    <p>Only continue if you started this yourself, on your own device, a moment ago.</p>
    <button class="btn btn--primary" onclick={approve} disabled={stage === "working"}>
      {stage === "working" ? "Saving…" : "Give it keys"}
    </button>
    <button class="btn btn--ghost" onclick={onclose} disabled={stage === "working"}>Cancel</button>
    <p class="muted">Your device will ask you to confirm it's you.</p>
  {:else if stage === "confirm" || stage === "working"}
    <p class="panel-title">Add this device to your account?</p>
    <p>Only continue if you started this yourself, on your own device, a moment ago.</p>
    <p>It will be able to do everything this device can - including removing your other passkeys.</p>
    <button class="btn btn--primary" onclick={approve} disabled={stage === "working"}>
      {stage === "working" ? "Adding…" : "Add device"}
    </button>
    <button class="btn btn--ghost" onclick={onclose} disabled={stage === "working"}>Cancel</button>
    <p class="muted">Your device will ask you to confirm it's you.</p>
  {:else}
    <p class="ok">{gaveKeys ? "Keys saved. Finish on the other device." : "Added. Finish on the other device."}</p>
    <button class="btn btn--ghost" onclick={onclose}>Done</button>
  {/if}
  {#if error}<p class="err">{error}</p>{/if}
</div>

<style>
  .link {
    display: grid;
    gap: 0.6rem;
    justify-items: start;
  }
  .link p {
    margin: 0;
    color: var(--text-secondary);
  }
  .typed {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    width: 100%;
  }
  .typed input {
    flex: 1 1 16rem;
    min-width: 0;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    color: var(--text);
    font-family: var(--font-mono);
    text-transform: uppercase;
  }
  .link .panel-title {
    color: var(--text);
    font-weight: 500;
  }
  .muted {
    color: var(--text-muted);
    font-size: 0.875rem;
  }
  .err {
    margin: 0;
    color: var(--error);
  }
  .ok {
    margin: 0;
    color: var(--accent-text);
  }
</style>
