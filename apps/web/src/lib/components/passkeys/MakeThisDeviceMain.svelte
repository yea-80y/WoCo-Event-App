<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import PairingCode from "./PairingCode.svelte";

  /**
   * "Make this device the main one" (#746 step 4), on a linked device: show a code for
   * the main device to scan; it confirms, this device signs the other devices back in,
   * and the main hands over. Nothing changes until the main device confirms.
   */

  let { onchanged, onclose }: { onchanged: () => void; onclose: () => void } = $props();

  let stage = $state<"intro" | "starting" | "waiting" | "signing" | "finishing" | "done">("intro");
  let code = $state<{ typed: string; qr: string } | null>(null);
  let error = $state<string | null>(null);
  let note = $state<string | null>(null);
  let controller: AbortController | null = null;

  async function start(): Promise<void> {
    if (stage !== "intro") return;
    error = null;
    stage = "starting";
    controller = new AbortController();
    try {
      const { registered } = await auth.makeThisDeviceMain({
        signal: controller.signal,
        onStep: (s) => (stage = s),
        onCode: (c) => (code = c),
      });
      if (!registered) note = "Some devices still need to be re-linked - this finishes by itself next time you open Your passkeys.";
      stage = "done";
      onchanged();
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      error =
        name === "AbortError"
          ? null
          : name === "PasskeyCeremonyCancelledError"
            ? "Nothing was changed."
            : e instanceof Error
              ? e.message
              : "Nothing was changed.";
      stage = "intro";
    } finally {
      code = null;
      controller = null;
    }
  }

  // Leaving the screen stops waiting; anything already signed finishes next time.
  $effect(() => () => controller?.abort());
</script>

<div class="make-main">
  {#if stage === "intro" || stage === "starting"}
    <p>
      Make this device your main passkey? The main passkey is the one that can add or remove passkeys, change names and
      set up backups. Your current main device needs to confirm.
    </p>
    <button class="btn btn--primary" onclick={start} disabled={stage === "starting"}>Show a code</button>
    <button class="btn btn--ghost" onclick={onclose} disabled={stage === "starting"}>Not now</button>
  {:else if stage === "waiting"}
    <p>
      On the device with your main passkey, open WoCo, go to Your passkeys and choose Link another device. Scan this code,
      or type it there:
    </p>
    {#if code}<PairingCode qr={code.qr} typed={code.typed} />{/if}
    <p class="muted">The code works for 10 minutes.</p>
    <button class="btn btn--ghost" onclick={() => controller?.abort()}>Cancel</button>
  {:else if stage === "signing"}
    <p class="muted">Confirm on this device to keep your other devices signed in…</p>
  {:else if stage === "finishing"}
    <p class="muted">Waiting for the change to go through…</p>
  {:else}
    <p class="ok">This device is now your main passkey.</p>
    {#if note}<p class="muted">{note}</p>{/if}
    <button class="btn btn--ghost" onclick={onclose}>Done</button>
  {/if}
  {#if error}<p class="err">{error}</p>{/if}
</div>

<style>
  .make-main {
    display: grid;
    gap: 0.6rem;
    justify-items: start;
  }
  .make-main p {
    margin: 0;
    color: var(--text-secondary);
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
