<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { navigate } from "../../router/router.svelte.js";
  import PairingCode from "./PairingCode.svelte";

  /**
   * "Add this device" (#746), on the device being added: make its own passkey, show a
   * code for one of the account's devices to scan, and sign in once it answers. Nothing
   * is stored here until that device has confirmed and the server agrees.
   */

  let stage = $state<"intro" | "creating" | "waiting" | "linking" | "done">("intro");
  let code = $state<{ typed: string; qr: string } | null>(null);
  // Which account this device joined - the one check a person has that the answer
  // came from their own main device (Fable sign-off SHOULD-8).
  let joined = $state<string | null>(null);
  let error = $state<string | null>(null);
  let controller: AbortController | null = null;

  async function start(): Promise<void> {
    if (stage !== "intro") return;
    error = null;
    stage = "creating";
    controller = new AbortController();
    try {
      await auth.linkThisDevice({
        signal: controller.signal,
        onStep: (s) => (stage = s),
        onCode: (c) => (code = c),
      });
      stage = "done";
      void name(auth.parent);
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
      code = null;
      controller = null;
    }
  }

  async function name(parent: string | null): Promise<void> {
    if (!parent) return;
    joined = `${parent.slice(0, 6)}…${parent.slice(-4)}`;
    try {
      const { getProfile } = await import("../../api/profiles.js");
      const profile = await getProfile(parent);
      if (profile?.displayName) joined = profile.displayName;
    } catch {
      /* the short address stays */
    }
  }

  // Leaving the screen ends the wait; the passkey already made is reused next time.
  $effect(() => () => controller?.abort());
</script>

<section class="link-this">
  <h2>Add this device</h2>

  {#if auth.isConnected && stage !== "done"}
    <p class="muted">You're already signed in on this device.</p>
    <button class="btn btn--ghost" onclick={() => navigate("/passkeys")}>Your passkeys</button>
  {:else if stage === "intro" || stage === "creating"}
    <p class="muted">
      You'll make a passkey on this device, then confirm on the device you already use. Nothing changes until it
      confirms.
    </p>
    <button class="btn btn--primary" onclick={start} disabled={stage === "creating"}>
      {stage === "creating" ? "Making a passkey…" : "Make a passkey for this device"}
    </button>
    <button class="btn btn--ghost" onclick={() => loginRequest.request()} disabled={stage === "creating"}>
      Already have your WoCo passkey here? Sign in
    </button>
  {:else if stage === "waiting"}
    <p class="muted">
      On the device you already use, open WoCo, go to Your passkeys and tap Add another device. Scan this code, or type
      it there:
    </p>
    {#if code}<PairingCode qr={code.qr} typed={code.typed} />{/if}
    <p class="muted">Waiting for your other device… The code works for 10 minutes.</p>
    <button class="btn btn--ghost" onclick={() => controller?.abort()}>Cancel</button>
  {:else if stage === "linking"}
    <p class="muted">Linking…</p>
  {:else}
    <p class="ok">
      This device is on your account{joined ? `, ${joined}` : ""}. It signs in with the passkey you just made and can do
      everything your other device can.
    </p>
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
  .err {
    margin: 0;
    color: var(--error);
  }
  .ok {
    margin: 0;
    color: var(--accent-text);
  }
</style>
