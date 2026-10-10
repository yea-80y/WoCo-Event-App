<script lang="ts">
  import { onMount } from "svelte";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { isOrphanedCredentialError } from "../../auth/orphaned-credential.js";
  import { isWeb3AuthSignInError } from "../../auth/web3auth-signin-error.js";
  import { isSignInFailedError, SIGN_IN_FAILED_MESSAGE } from "../../auth/signin-failure.js";
  import type { InAppBrowser } from "../../browser/in-app-browser.js";
  import type { EscapeLink } from "../../browser/in-app-escape.js";

  interface Props {
    oncomplete?: () => void;
    /** Attempt started — the modal swaps to its authenticating scene. */
    onstart?: () => void;
    /** Attempt settled (either way) — the modal returns to the picker. */
    onsettle?: () => void;
    /** The app's built-in browser this page is in, if any: a stalled or timed-out
     *  wait then offers the way out beside Try again (owner decision 2026-10-10). */
    inApp: InAppBrowser | null;
  }

  let { oncomplete, onstart, onsettle, inApp }: Props = $props();

  let error = $state<string | null>(null);
  /** A failure with no words of its own carries a short code to screenshot (signin-failure.ts). */
  let errorCode = $state<string | null>(null);
  /** The attempt under way, so Try again can wait for the cancelled one to settle. */
  let attempt: Promise<unknown> | null = null;

  // The spinner's time ran out (web3auth-signin-wait.ts): the attempt is still
  // listening for a late result, which signs the person in by itself.
  const stalled = $derived(auth.busy && auth.loginStage === "stalled");

  // Warm the (large) Web3Auth modal SDK while the user reads the options, so
  // the click spends its time on init + the modal, not the bundle download.
  onMount(() => {
    void auth.prefetchWeb3AuthSdk();
  });

  // The link out of an in-app browser, built only when there is one to show.
  let escape = $state<EscapeLink | null>(null);
  $effect(() => {
    if (!inApp || !(stalled || error)) return;
    void import("../../browser/in-app-escape.js").then(({ escapeLink }) => {
      escape = escapeLink(inApp, new URL(window.location.href));
    });
  });
  const escapeLabel = $derived(
    escape?.kind === "chrome" ? "Open in Chrome" : escape?.kind === "safari" ? "Open in Safari" : "Open in your browser",
  );

  async function login() {
    error = null;
    errorCode = null;
    onstart?.();
    const run = auth.loginWeb3Auth();
    attempt = run;
    try {
      const ok = await run;
      if (ok) oncomplete?.();
      else {
        // Only when another sign-in was already under way (the store's busy guard).
        error = SIGN_IN_FAILED_MESSAGE;
        errorCode = "W3A-busy";
      }
    } catch (e: unknown) {
      // An orphaned-credential refusal (#255) is explained by the modal's
      // one-shot notice — don't repeat it here. Closing Web3Auth's own window
      // is a choice, not a failure: say nothing (#803).
      if (isWeb3AuthSignInError(e) && e.cancelled) {
        error = null;
      } else if (!isOrphanedCredentialError(e)) {
        error = e instanceof Error ? e.message.slice(0, 160) : SIGN_IN_FAILED_MESSAGE;
        if (isSignInFailedError(e)) errorCode = e.code;
      }
    } finally {
      onsettle?.();
    }
  }

  /** Try again: end the stalled wait (a quiet cancel), then start afresh. */
  async function retry() {
    auth.cancelLogin();
    await attempt;
    await login();
  }
</script>

<div class="w3a-login">
  {#if stalled}
    <div class="stalled" role="status" aria-live="polite">
      <p class="stalled-title">Still waiting for your sign-in to come back</p>
      <p class="stalled-body">
        If you finished signing in with Google or email, it should appear here by itself in a moment. If it doesn't,
        tap Try again{inApp ? ", or open WoCo in your browser" : ""}.
      </p>
      <button type="button" class="w3a-btn" onclick={retry}>Try again</button>
      {#if escape}
        <a class="open-btn" href={escape.href}>{escapeLabel}</a>
      {/if}
    </div>
  {:else}
    <button class="w3a-btn" onclick={login} disabled={auth.busy}>
      {#if auth.busy}
        <span class="spinner"></span>Connecting…
      {:else}
        Continue with Email
      {/if}
    </button>
    {#if error}
      <p class="error">{error}</p>
      {#if errorCode}
        <p class="error-code">Code: <code>{errorCode}</code></p>
      {/if}
      {#if escape}
        <a class="open-btn" href={escape.href}>{escapeLabel}</a>
      {/if}
    {/if}
    <p class="hint">
      {inApp ? "Google or email sign-in may not complete in this browser." : "Use your email address or Google account"}
    </p>
  {/if}
</div>

<style>
  .w3a-login {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .w3a-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.75rem;
    font-size: 0.9375rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    color: var(--text);
    border: 1px solid var(--border);
    transition: border-color var(--transition), color var(--transition);
  }

  .w3a-btn:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent-text);
  }

  .w3a-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .stalled {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.875rem 1rem;
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--accent-subtle);
  }

  .stalled-title {
    margin: 0;
    font-weight: 600;
    color: var(--text);
  }

  .stalled-body {
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.45;
    color: var(--text-secondary);
  }

  .open-btn {
    display: block;
    padding: 0.7rem 1rem;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 600;
    text-align: center;
    text-decoration: none;
  }

  .hint {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin: 0;
    text-align: center;
  }

  .error {
    color: var(--error);
    font-size: 0.875rem;
    margin: 0;
    text-align: center;
  }

  .error-code {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-muted);
    text-align: center;
    overflow-wrap: anywhere;
  }

  .error-code code {
    user-select: all;
    -webkit-user-select: all;
  }

  .spinner {
    width: 0.85rem;
    height: 0.85rem;
    flex: none;
    border: 2px solid color-mix(in srgb, currentColor 35%, transparent);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }
</style>
