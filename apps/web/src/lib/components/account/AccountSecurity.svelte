<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { navigate, replaceRoute, router } from "../../router/router.svelte.js";
  import { authPost } from "../../api/client.js";
  import { authKindLabel, authKindColor } from "../../auth/kind-label.js";
  import { canProtectAccount } from "../../auth/backup-prompt.js";
  import YourPasskeys from "../passkeys/YourPasskeys.svelte";

  /**
   * Account & security (`#/account`, and `#/passkeys` for links made before it):
   * the account's own controls, kept off the Profile tab, which is the person's
   * public page. Nothing here asks for a passkey on open.
   */

  const address = $derived(auth.parent?.toLowerCase() ?? "");
  const shortAddr = $derived(address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "");
  // Email accounts back up on Protect, while that rail is on (FEATURES.accountBackupsAllowed).
  const protectHere = $derived(auth.kind !== "passkey" && canProtectAccount(auth.kind));

  // Profile's "Add a device" lands here as `#/account?add-device` - a flag, never a
  // code. Taken once and replaced out of the address, so a reload or Back never opens
  // the scanner again. YourPasskeys opens it only where its own button is offered.
  let addDevice = $state(false);
  $effect(() => {
    if (router.params.addDevice !== "1") return;
    addDevice = true;
    replaceRoute("/account");
  });

  let addressCopied = $state(false);
  let revokingAll = $state(false);
  let revokeSuccess = $state(false);
  let revokeFailed = $state(false);

  async function copyAddress() {
    if (!address) return;
    await navigator.clipboard.writeText(address);
    addressCopied = true;
    setTimeout(() => { addressCopied = false; }, 2000);
  }

  async function revokeAllSessions() {
    if (revokingAll) return;
    revokingAll = true;
    let revoked = false;
    try {
      // authPost resolves on a refusal too, so "Done" must wait for ok.
      const res = await authPost("/api/auth/revoke-all", {});
      if (!res.ok) throw new Error(res.error ?? "Revoke failed");
      revoked = true;
      revokeSuccess = true;
    } catch (err) {
      console.error("Revoke sessions failed:", err);
      revokeFailed = true;
      setTimeout(() => { revokeFailed = false; }, 4000);
    } finally {
      revokingAll = false;
    }
    // "Every device" includes this one (#186). Outside the try: the server has
    // already revoked, so a local sign-out hiccup must not read as "failed".
    if (revoked) await auth.onSessionRevoked();
  }
</script>

<div class="account">
  <header class="page-head">
    <h1>Account & security</h1>
    {#if auth.isConnected}
      <p class="lede">How you sign in, the passkeys that open your account, and where you're signed in.</p>
    {/if}
  </header>

  {#if !auth.isConnected || !auth.parent}
    <p class="muted">Sign in to see how your account is kept safe.</p>
    <button class="btn btn--primary" onclick={() => loginRequest.request()}>Sign in</button>
  {:else}
    <section class="block" aria-labelledby="signin-title">
      <h2 id="signin-title">Sign-in</h2>
      <div class="rows">
        <div class="row">
          <span class="label">Sign-in method</span>
          <span class="value">
            <span class="dot" style="background:{authKindColor[auth.kind ?? ''] ?? 'var(--text-muted)'}"></span>
            {authKindLabel[auth.kind ?? ""] ?? "Unknown"}
          </span>
        </div>
        <div class="row">
          <span class="label">Address</span>
          <button class="copy" onclick={copyAddress} title={address}>
            <span class="mono">{shortAddr}</span>
            <span class="copy-label" class:done={addressCopied}>{addressCopied ? "Copied" : "Copy"}</span>
          </button>
        </div>
        {#if protectHere}
          <div class="row">
            <span class="label">Account backups</span>
            <!-- navigate(), never a bare "#/" link: the gateway <base href> would send it off this origin. -->
            <button class="link" onclick={() => navigate("/protect")}>Manage</button>
          </div>
        {/if}
      </div>
    </section>

    {#if auth.kind === "passkey"}
      <YourPasskeys bind:addDevice />
    {/if}

    <section class="block" aria-labelledby="sessions-title">
      <h2 id="sessions-title">Sessions</h2>
      <p class="muted">
        Sign out all active sessions on every device and browser, this one included. You'll need to sign in again on
        each.
      </p>
      <div class="session-row">
        <span class="session-status"><span class="session-dot"></span>Session active</span>
        <button class="revoke-btn" onclick={revokeAllSessions} disabled={revokingAll}>
          {#if revokingAll}
            Signing out...
          {:else if revokeSuccess}
            Done
          {:else if revokeFailed}
            Didn't work - try again
          {:else}
            Sign out everywhere
          {/if}
        </button>
      </div>
    </section>
  {/if}
</div>

<style>
  .account {
    display: grid;
    gap: 2rem;
    max-width: 38rem;
    margin: 0 auto;
    padding: 1.5rem 0 2.5rem;
  }
  .page-head {
    display: grid;
    gap: 0.4rem;
  }
  h1 {
    margin: 0;
    font-family: var(--font-display);
    font-weight: 500;
    font-size: 1.75rem;
    letter-spacing: -0.01em;
  }
  p {
    margin: 0;
  }
  .lede {
    color: var(--text-secondary);
  }
  .muted {
    color: var(--text-muted);
    font-size: 0.875rem;
  }
  .block {
    display: grid;
    gap: 0.75rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--border);
  }
  h2 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 1.125rem;
    font-weight: 600;
    letter-spacing: -0.005em;
  }
  .rows {
    display: grid;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    min-height: 2.75rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border);
  }
  .row:last-child {
    border-bottom: none;
  }
  .label {
    color: var(--text-secondary);
    font-size: 0.875rem;
  }
  .value {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--text);
    font-size: 0.875rem;
    font-weight: 600;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .copy,
  .link {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 2.75rem;
    padding: 0;
    border: 0;
    background: none;
    cursor: pointer;
    font: inherit;
  }
  .copy {
    color: var(--text-secondary);
  }
  .copy:hover {
    color: var(--accent-text);
  }
  .mono {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
  }
  .copy-label {
    color: var(--text-muted);
    font-size: 0.75rem;
  }
  .copy-label.done {
    color: var(--accent-text);
  }
  .link {
    color: var(--accent-text);
    font-size: 0.875rem;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .session-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .session-status {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    color: var(--text-secondary);
    font-size: 0.875rem;
  }
  .session-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--success);
  }
  .revoke-btn {
    min-height: 2.75rem;
    padding: 0 1rem;
    border: 1px solid color-mix(in srgb, var(--error) 25%, var(--border));
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--error) 8%, transparent);
    color: var(--error);
    font: inherit;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    transition: background var(--transition), border-color var(--transition);
  }
  .revoke-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--error) 15%, transparent);
    border-color: color-mix(in srgb, var(--error) 40%, var(--border));
  }
  .revoke-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
