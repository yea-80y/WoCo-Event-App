<script lang="ts">
  import { encode } from "uqr";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { navigate } from "../../router/router.svelte.js";

  /**
   * "Link this device" (#746 step 4), on the device being added: make its own passkey,
   * show a code for the main device to scan, and sign in once that device answers.
   * Nothing is stored here until the main device has confirmed and the server agrees.
   */

  let stage = $state<"intro" | "creating" | "waiting" | "linking" | "done">("intro");
  let typed = $state("");
  let qr = $state<{ size: number; path: string } | null>(null);
  let error = $state<string | null>(null);
  let controller: AbortController | null = null;

  function draw(payload: string): void {
    const { data } = encode(payload, { ecc: "M", border: 2 });
    let path = "";
    for (let y = 0; y < data.length; y++) {
      for (let x = 0; x < data.length; x++) if (data[y][x]) path += `M${x} ${y}h1v1h-1z`;
    }
    qr = { size: data.length, path };
  }

  async function start(): Promise<void> {
    if (stage !== "intro") return;
    error = null;
    stage = "creating";
    controller = new AbortController();
    try {
      await auth.linkThisDevice({
        signal: controller.signal,
        onStep: (s) => (stage = s),
        onCode: (c) => {
          typed = c.typed;
          draw(c.qr);
        },
      });
      stage = "done";
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      error =
        name === "AbortError"
          ? null
          : name === "PasskeyCeremonyCancelledError"
            ? "No passkey was made. Try again when you're ready."
            : e instanceof Error
              ? e.message
              : "Couldn't link this device. Start again.";
      stage = "intro";
    } finally {
      qr = null;
      typed = "";
      controller = null;
    }
  }

  // Leaving the screen ends the wait; the passkey already made is reused next time.
  $effect(() => () => controller?.abort());
</script>

<section class="link-this">
  <h2>Link this device</h2>

  {#if auth.isConnected && stage !== "done"}
    <p class="muted">You're already signed in on this device.</p>
    <button class="btn btn--ghost" onclick={() => navigate("/passkeys")}>Your passkeys</button>
  {:else if stage === "intro" || stage === "creating"}
    <p class="muted">
      You'll make a passkey on this device, then confirm from the device you already use. Nothing changes until that
      device confirms.
    </p>
    <button class="btn btn--primary" onclick={start} disabled={stage === "creating"}>
      {stage === "creating" ? "Making a passkey…" : "Make a passkey for this device"}
    </button>
    <button class="btn btn--ghost" onclick={() => loginRequest.request()} disabled={stage === "creating"}>
      Already have your WoCo passkey here? Sign in
    </button>
  {:else if stage === "waiting"}
    <p class="muted">
      On the device you already use, open WoCo, go to Your passkeys and choose Link another device. Scan this code, or
      type it there:
    </p>
    {#if qr}
      <svg class="qr" viewBox="0 0 {qr.size} {qr.size}" shape-rendering="crispEdges" role="img" aria-label="Link code">
        <rect width={qr.size} height={qr.size} class="paper" />
        <path d={qr.path} class="ink" />
      </svg>
    {/if}
    <p class="code">{typed}</p>
    <p class="muted">Waiting for your other device… The code works for 10 minutes.</p>
    <button class="btn btn--ghost" onclick={() => controller?.abort()}>Cancel</button>
  {:else if stage === "linking"}
    <p class="muted">Linking…</p>
  {:else}
    <p class="ok">This device is linked. It signs in with the passkey you just made.</p>
    <button class="btn btn--primary" onclick={() => navigate("/home")}>Continue</button>
  {/if}
  {#if error}<p class="err">{error}</p>{/if}
</section>

<style>
  .link-this {
    display: grid;
    gap: 1rem;
    justify-items: start;
    max-width: 32rem;
    margin: 0 auto;
    padding: 1.5rem 1rem;
  }
  h2 {
    margin: 0;
    font-family: var(--font-display);
  }
  .muted {
    margin: 0;
    color: var(--text-secondary);
  }
  .qr {
    width: min(16rem, 100%);
    height: auto;
    border-radius: var(--radius-md);
  }
  .paper {
    fill: var(--text);
  }
  .ink {
    fill: var(--bg);
  }
  .code {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 1.1rem;
    letter-spacing: 0.04em;
    color: var(--text);
    word-break: break-all;
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
