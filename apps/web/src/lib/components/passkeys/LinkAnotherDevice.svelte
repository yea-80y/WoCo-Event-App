<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import { apiBase } from "../../api/http.js";
  import type { PairingOffer } from "../../auth/device-link.js";

  /**
   * "Link another device" (#746 step 4), on the main device: read the code the other
   * device shows - with WoCo's own scanner or typed, never a phone's camera app - then
   * confirm with a passkey sheet every time, whatever the unlock window says. The code
   * either links that device or, if it is already linked, makes it the main passkey.
   */

  let { onlinked, onclose }: { onlinked: () => void; onclose: () => void } = $props();

  let stage = $state<"scan" | "reading" | "confirm" | "working" | "done">("scan");
  let kind = $state<PairingOffer["kind"]>("link");
  let progress = $state("");
  let camera = $state(false);
  let typed = $state("");
  let error = $state<string | null>(null);
  let note = $state<string | null>(null);
  let pending: { code: Uint8Array; offer: PairingOffer } | null = null;

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
      kind = pending.offer.kind;
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

  const STEP: Record<string, string> = {
    waiting: "Confirm on the other device…",
    changing: "Changing your main passkey…",
    finishing: "Finishing…",
  };

  async function approve(): Promise<void> {
    if (stage !== "confirm" || !pending) return;
    stage = "working";
    error = null;
    progress = "";
    try {
      if (pending.offer.kind === "link") {
        await auth.approveDeviceLink(pending.code, pending.offer);
      } else {
        const { registered } = await auth.approveMakeMain(pending.code, pending.offer, (s) => (progress = STEP[s] ?? ""));
        if (!registered) note = "Some devices still need to be re-linked - this finishes by itself next time you open Your passkeys.";
      }
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
  {#if stage === "scan" || stage === "reading"}
    <p>On the other device, open WoCo and choose Link this device. Then scan the code it shows, or type it here.</p>
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
  {:else if stage === "confirm" || stage === "working"}
    {#if kind === "link"}
      <p>
        Link the other device to your account? Only continue if you started this yourself, on your own device, a moment
        ago. It will be able to act as you, including reading your attendee details.
      </p>
    {:else}
      <p>
        Make the other device your main passkey? This one will still sign in, as a linked device. Only the main passkey
        can add or remove passkeys, change names or set up backups. You can make this one the main passkey again later.
      </p>
    {/if}
    {#if stage === "working" && progress}<p class="muted">{progress}</p>{/if}
    <button class="btn btn--primary" onclick={approve} disabled={stage === "working"}>
      {stage === "working" ? "Working…" : kind === "link" ? "Link device" : "Make it the main passkey"}
    </button>
    <button class="btn btn--ghost" onclick={onclose} disabled={stage === "working"}>Cancel</button>
  {:else}
    <p class="ok">
      {kind === "link"
        ? "Linked. Finish on the other device."
        : "Done - the other device is now your main passkey. This one stays signed in as a linked device."}
    </p>
    {#if note}<p class="muted">{note}</p>{/if}
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
  .err {
    margin: 0;
    color: var(--error);
  }
  .ok {
    margin: 0;
    color: var(--accent-text);
  }
</style>
