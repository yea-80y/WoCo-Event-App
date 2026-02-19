<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import { isPasskeySupported, hasStoredPasskeyCredential } from "../../auth/passkey-account.js";
  import { onMount } from "svelte";

  interface Props {
    oncomplete?: () => void;
  }

  let { oncomplete }: Props = $props();
  let error = $state<string | null>(null);
  let supported = $state(false);
  let hasExisting = $state(false);

  onMount(async () => {
    supported = isPasskeySupported();
    if (supported) {
      hasExisting = await hasStoredPasskeyCredential();
    }
  });

  async function handleLogin() {
    error = null;
    const ok = await auth.login("passkey");
    if (ok) {
      oncomplete?.();
    } else {
      error = "Passkey authentication failed. Try again or use another method.";
    }
  }
</script>

{#if supported}
  <div class="passkey-login">
    <button
      class="passkey-btn"
      onclick={handleLogin}
      disabled={auth.busy}
    >
      <!-- Passkey / fingerprint icon -->
      <svg class="passkey-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M17.81 4.47c-.08 0-.16-.02-.23-.06C15.66 3.42 14 3 12.01 3c-1.98 0-3.86.47-5.57 1.41-.24.13-.54.04-.68-.2-.13-.24-.04-.55.2-.68C7.82 2.52 9.86 2 12.01 2c2.13 0 3.99.47 6.03 1.52.25.13.34.43.21.67-.09.18-.26.28-.44.28zM3.5 9.72a.499.499 0 0 1-.25-.93C5.45 7.33 8.34 6.25 12 6.25c3.67 0 6.56 1.08 8.75 2.54.23.16.29.48.13.71-.16.23-.48.29-.71.13C18.14 8.31 15.36 7.25 12 7.25c-3.35 0-6.13 1.06-8.25 2.34-.08.09-.16.13-.25.13zM12 22c-1.23 0-2.4-.32-3.37-.96-.13-.09-.21-.23-.21-.39 0-.16.07-.32.21-.41l.66-.45a.678.678 0 0 1 .68-.03c.65.37 1.33.56 2.03.56 2.37 0 4.3-2.07 4.3-4.61 0-2.55-1.93-4.61-4.3-4.61-2.33 0-4.29 2.02-4.3 4.53v.08c-.01.53-.19 1.88-1.3 3.48-.07.1-.18.16-.3.18h-.02c-.12 0-.24-.05-.31-.15A8.24 8.24 0 0 1 4 14.35C4 9.73 7.59 6 12 6s8 3.73 8 8.35S16.41 22 12 22zM7.33 15.63c-.56 0-1.01-.49-1.01-1.09 0-.6.45-1.09 1.01-1.09.56 0 1.01.49 1.01 1.09 0 .6-.45 1.09-1.01 1.09z" fill="currentColor"/>
      </svg>
      {#if auth.busy}
        Authenticating...
      {:else if hasExisting}
        Sign in with Passkey
      {:else}
        Create Passkey Account
      {/if}
    </button>

    <div class="providers">
      <span class="provider-label">Secured by</span>
      <div class="provider-icons">
        <!-- Apple -->
        <svg class="provider-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-label="Apple">
          <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C3.79 16.17 4.36 9.53 8.7 9.28c1.28.06 2.15.72 2.9.78.96-.2 1.88-.89 2.9-.8 1.21.11 2.13.6 2.73 1.54-2.48 1.52-1.89 4.87.58 5.8-.48 1.34-.97 2.68-1.76 3.68zM12.03 9.22c-.12-2.37 1.79-4.37 4.03-4.56.27 2.6-2.34 4.68-4.03 4.56z" fill="currentColor"/>
        </svg>
        <!-- Google -->
        <svg class="provider-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-label="Google">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09A6.88 6.88 0 0 1 5.48 12c0-.72.13-1.42.36-2.09V7.07H2.18A11.96 11.96 0 0 0 1 12c0 1.94.47 3.77 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        <!-- Microsoft / Windows Hello -->
        <svg class="provider-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-label="Microsoft">
          <path d="M3 3h8.5v8.5H3z" fill="#F25022"/>
          <path d="M12.5 3H21v8.5h-8.5z" fill="#7FBA00"/>
          <path d="M3 12.5h8.5V21H3z" fill="#00A4EF"/>
          <path d="M12.5 12.5H21V21h-8.5z" fill="#FFB900"/>
        </svg>
        <!-- 1Password -->
        <svg class="provider-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-label="1Password">
          <circle cx="12" cy="12" r="11" fill="none" stroke="currentColor" stroke-width="1.5"/>
          <text x="12" y="16.5" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor" font-family="system-ui, sans-serif">1</text>
        </svg>
      </div>
    </div>

    <p class="hint">
      {#if hasExisting}
        Your passkey produces the same account on any synced device.
      {:else}
        Creates a crypto account secured by your device. Syncs automatically via iCloud, Google, or your password manager.
      {/if}
    </p>

    {#if error}
      <p class="error">{error}</p>
    {/if}
  </div>
{/if}

<style>
  .passkey-login {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.625rem;
  }

  .passkey-btn {
    padding: 0.75rem;
    font-size: 0.9375rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    color: var(--text);
    border: 1px solid var(--border);
    transition: all var(--transition);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
  }

  .passkey-btn:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent-text);
  }

  .passkey-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .passkey-icon {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
  }

  .providers {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
  }

  .provider-label {
    font-size: 0.6875rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .provider-icons {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .provider-icon {
    width: 16px;
    height: 16px;
    opacity: 0.55;
    transition: opacity var(--transition);
    color: var(--text-muted);
  }

  .provider-icon:hover {
    opacity: 0.85;
  }

  .hint {
    color: var(--text-muted);
    font-size: 0.75rem;
    text-align: center;
    margin: 0;
    line-height: 1.45;
  }

  .error {
    color: var(--error);
    font-size: 0.875rem;
    margin: 0;
    text-align: center;
  }
</style>
