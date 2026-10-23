<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import {
    isPasskeySupported,
    PasskeyBrowserRefusedError,
    PasskeyPrfUnsupportedError,
  } from "../../auth/passkey-account.js";
  import { primePasskeyWindow } from "../../auth/passkey-window.js";
  import {
    appleTouchDevice,
    passkeyCreateRefusedAdvice,
    passkeyNoSecretAdvice,
    passkeyRefusalAdvice,
  } from "../../auth/passkey-refusal-copy.js";
  import { PASSKEY_PROVIDERS } from "@woco/shared";
  import type { SheetState } from "../../auth/sign-in-hint.js";
  import PasskeyReadyNotice from "./PasskeyReadyNotice.svelte";
  import { onMount, tick, type Snippet } from "svelte";

  interface Props {
    oncomplete?: () => void;
    /** Attempt started — the modal swaps to its authenticating scene (which says more for a create). */
    onstart?: (mode: "signin" | "create") => void;
    /** Attempt settled (either way) — the modal returns to the picker. */
    onsettle?: () => void;
    /** "Link this device" (#746 step 4) was chosen: the modal closes for its screen. */
    onlink?: () => void;
    /** An organiser sign-in (`isOrganiserSignIn`): a passkey is the only way in, so say so where it can't work. */
    organiser?: boolean;
    /** The sheet's other main way in (email / Google), placed right under the passkey button. */
    alternative?: Snippet;
    /** What this device says about who is signing in (sign-in-hint.ts). */
    sheet?: SheetState;
    /** An invite ("Create your account"): Create takes the fill when nothing is known. */
    newAccountFirst?: boolean;
  }

  let { oncomplete, onstart, onsettle, onlink, organiser = false, alternative, sheet = "new", newAccountFirst = false }: Props = $props();
  /** Where focus goes when a sign-in found nothing: the create choice this sheet shows. */
  let createChoice = $state<HTMLButtonElement | undefined>();
  let createLink = $state<HTMLButtonElement | undefined>();
  let error = $state<string | null>(null);
  let supported = $state(false);
  /** Set with `supported` on mount, so the no-passkey line never flashes before the check. */
  let checked = $state(false);
  /** Emphasises the create button after a sign-in found nothing — never auto-clicks it. */
  let offerCreate = $state(false);
  /** A sign-in from another device that could not be confirmed (#746): points at "Add this device". */
  let otherDevice = $state(false);
  /** "Can't find your passkey on this device?" (#746), opened by its link or after a sign-in found nothing. */
  let showHelp = $state(false);
  /** After a new account: its passkey stays on this kind of device (Samsung Pass, Windows Hello). */
  let stays = $state<{ name: string; worksOn: string } | null>(null);

  onMount(() => {
    supported = isPasskeySupported();
    checked = true;
    // Warm the chunks the post-biometric path needs (ethers; viem/zerodev on
    // first-device logins) so the click never stalls on a download.
    if (supported) void auth.prefetchPasskeySdk();
  });

  /**
   * Sign in and create are SEPARATE user decisions. A passkey is an account: if
   * sign-in comes back empty we cannot tell "you have none here" from "you
   * cancelled", so making a new one is offered, never assumed. Choosing wrong
   * strands the user's tickets and funds on the account they meant to reach.
   */
  const appleDevice = () => appleTouchDevice(navigator.userAgent, navigator.maxTouchPoints ?? 0);

  async function run(mode: "signin" | "create") {
    // FIRST, before any await: a browser opens the passkey window only inside the tap.
    primePasskeyWindow();
    let apple: ReturnType<typeof appleDevice> = null;
    error = null;
    otherDevice = false;
    onstart?.(mode);
    try {
      const res = await auth.loginPasskeyResult(mode);
      if (res.ok) {
        if (mode === "create") {
          // Say once, while it is fresh, that this passkey will not reach a laptop (#746).
          const { stayingPasskeyNote } = await import("../../auth/passkey-reach.js");
          stays = await stayingPasskeyNote().catch(() => null);
          if (stays) return;
        }
        oncomplete?.();
        return;
      }
      if (res.orphaned || res.removed) {
        // The modal's one-shot notice explains this refusal (#255, and an added
        // passkey removed from its account, #746) - a red line here would say
        // the same thing twice.
      } else if (res.otherDevice && onlink) {
        otherDevice = true;
        error = res.error?.message ?? null;
      } else if (res.noSheet) {
        // No prompt opened, so nothing was cancelled and nothing was found: the
        // create offer would be a guess. The message says what to do instead.
        error = res.error?.message ?? null;
      } else if (res.noAssertion && mode === "signin") {
        offerCreate = true;
        showHelp = true;
        error = "No passkey was used. If you cancelled, try again - if you're new to WoCo, create an account below.";
        // Emphasis alone is invisible to a screen reader: take focus to the way forward.
        void tick().then(() => (sheet === "new" ? createChoice : createLink)?.focus());
      } else if (mode === "create" && res.error?.name === "PasskeyCeremonyCancelledError" && (apple = appleDevice())) {
        // After a sheet (a quick refusal is noSheet, above): on an iPhone or iPad this
        // is also what "no password manager set up for passkeys" ends in.
        error = passkeyCreateRefusedAdvice(apple, organiser);
      } else if (mode === "create" && res.error instanceof PasskeyPrfUnsupportedError && (apple = appleDevice())) {
        // Face ID done, the passkey SAVED, in a manager that can't give the secret:
        // name it, and steer the retry to Apple's Passwords.
        const id = res.error.provider;
        const known = id && id in PASSKEY_PROVIDERS ? { id, name: PASSKEY_PROVIDERS[id as keyof typeof PASSKEY_PROVIDERS].name } : null;
        error = passkeyNoSecretAdvice(apple, known, organiser);
      } else if (res.error instanceof PasskeyBrowserRefusedError) {
        error = passkeyRefusalAdvice(res.error.host, organiser);
      } else {
        error = res.error?.message ?? "Passkey authentication failed. Try again or use another method.";
      }
    } finally {
      onsettle?.();
    }
  }
</script>

{#snippet passkeyIcon()}
  <!-- Passkey / fingerprint icon -->
  <svg class="passkey-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M17.81 4.47c-.08 0-.16-.02-.23-.06C15.66 3.42 14 3 12.01 3c-1.98 0-3.86.47-5.57 1.41-.24.13-.54.04-.68-.2-.13-.24-.04-.55.2-.68C7.82 2.52 9.86 2 12.01 2c2.13 0 3.99.47 6.03 1.52.25.13.34.43.21.67-.09.18-.26.28-.44.28zM3.5 9.72a.499.499 0 0 1-.25-.93C5.45 7.33 8.34 6.25 12 6.25c3.67 0 6.56 1.08 8.75 2.54.23.16.29.48.13.71-.16.23-.48.29-.71.13C18.14 8.31 15.36 7.25 12 7.25c-3.35 0-6.13 1.06-8.25 2.34-.08.09-.16.13-.25.13zM12 22c-1.23 0-2.4-.32-3.37-.96-.13-.09-.21-.23-.21-.39 0-.16.07-.32.21-.41l.66-.45a.678.678 0 0 1 .68-.03c.65.37 1.33.56 2.03.56 2.37 0 4.3-2.07 4.3-4.61 0-2.55-1.93-4.61-4.3-4.61-2.33 0-4.29 2.02-4.3 4.53v.08c-.01.53-.19 1.88-1.3 3.48-.07.1-.18.16-.3.18h-.02c-.12 0-.24-.05-.31-.15A8.24 8.24 0 0 1 4 14.35C4 9.73 7.59 6 12 6s8 3.73 8 8.35S16.41 22 12 22zM7.33 15.63c-.56 0-1.01-.49-1.01-1.09 0-.6.45-1.09 1.01-1.09.56 0 1.01.49 1.01 1.09 0 .6-.45 1.09-1.01 1.09z" fill="currentColor"/>
  </svg>
{/snippet}

{#if supported && stays}
  <!-- Signed in already: `alternative` is not offered beside "Got it", where it would read as a second choice. -->
  <div class="passkey-login stays" role="status">
    <p class="stays-title">Your passkey is in {stays.name}</p>
    <p class="stays-body">
      {stays.worksOn}. To use WoCo on a laptop too, add a backup passkey in another password manager - like Google
      Password Manager - from Account & security. That unlocks once a ticket is in your account, or once you or someone
      you invited verifies with Stripe.
    </p>
    <button class="passkey-btn" onclick={() => { stays = null; oncomplete?.(); }}>Got it</button>
  </div>
{:else if supported}
  <div class="passkey-login">
    {#if sheet === "new"}
      <!-- Nothing known about this device (sign-in-hint.ts), so the two passkey choices
           sit side by side, each saying who it is for: iOS answers a newcomer's "Sign in"
           with its own "no passkeys" sheet, and no page can tell beforehand. Sign in takes
           the fill: its wrong tap costs a newcomer one sheet, while Create's costs a
           returning user a second account (Fable 10-22) - except on an invite, whose
           heading already says "Create your account". -->
      <button class="passkey-btn choice" class:outlined={newAccountFirst} onclick={() => run("signin")} disabled={auth.busy}>
        {@render passkeyIcon()}
        <span class="choice-text">
          <span class="choice-label">{auth.busy ? "Authenticating..." : "Sign in with Passkey"}</span>
          <span class="choice-sub">I already have a WoCo passkey</span>
        </span>
      </button>
      <button bind:this={createChoice} class="passkey-btn choice" class:outlined={!newAccountFirst} onclick={() => run("create")} disabled={auth.busy}>
        <svg class="passkey-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
        <span class="choice-text">
          <span class="choice-label">Create an account</span>
          <span class="choice-sub">New to WoCo</span>
        </span>
      </button>
    {:else}
      <button
        class="passkey-btn"
        onclick={() => run("signin")}
        disabled={auth.busy}
      >
        {@render passkeyIcon()}
        {#if auth.busy}
          Authenticating...
        {:else}
          Sign in with Passkey
          <!-- Inside the button: part of its name, not a colour cue beside it. -->
          {#if sheet === "known"}<span class="last-used">Last used</span>{/if}
        {/if}
      </button>
    {/if}

    <!-- Right under the button it is about, and still right above the email
         button that the refusal advice points to ("... below"). -->
    {#if error && !otherDevice}
      <p class="error" role="alert">{error}</p>
    {/if}

    <!-- The two real choices sit together, so the second is seen without scrolling. -->
    {@render alternative?.()}

    <!-- Below both choices: on an iPhone it is a long paragraph, and it is about Create. -->
    <PasskeyReadyNotice invite={organiser} />

    <div class="more">
      <!-- Always present, always secondary. `hasStoredPasskeyCredential` only
           knows about THIS device, so it cannot tell a brand-new user from a
           returning one on a new device — promoting create on its say-so is how a
           returning user ends up with a second account. Let the user say which. -->
      {#if sheet !== "new"}
        <button
          bind:this={createLink}
          class="create-btn"
          class:emphasised={offerCreate}
          onclick={() => run("create")}
          disabled={auth.busy}
        >
          New to WoCo? Create a passkey account
        </button>
      {/if}

      {#if onlink}
        {#if otherDevice && error}
          <p class="error" role="alert">{error}</p>
        {/if}
        <button class="create-btn" class:emphasised={otherDevice} onclick={onlink} disabled={auth.busy}>
          Already use WoCo on another device? Add this device
        </button>
      {/if}

      {#if !showHelp}
        <button class="help-link" onclick={() => (showHelp = true)} disabled={auth.busy}>
          Can't find your passkey?
        </button>
      {:else}
        {#await import("./PasskeyHelp.svelte") then { default: PasskeyHelp }}
          <PasskeyHelp busy={auth.busy} onretry={() => run("signin")} {onlink} />
        {/await}
      {/if}
    </div>

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
      Your passkey produces the same account on any synced device. Creating a new
      one makes a separate account, and won't restore an existing one.
    </p>
  </div>
{:else if checked && organiser}
  <!-- Nothing else is offered to an organiser, so an empty sheet here would be a dead end. -->
  <p class="error" role="alert">
    This browser can't use passkeys, and organising needs one - open WoCo in Chrome, Brave, Edge or Safari to continue.
  </p>
{:else if checked}
  <!-- No passkeys in this browser: the other way in is all there is. -->
  {@render alternative?.()}
{/if}

<style>
  .passkey-login {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.625rem;
  }

  /* Hero method — WoCo's native account gets the accent treatment. */
  .passkey-btn {
    padding: 0.875rem;
    font-size: 0.9375rem;
    font-weight: 700;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: var(--accent-ink);
    border: 1px solid var(--accent);
    transition: background var(--transition);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
  }

  .passkey-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  /* The first-visit pair: one height, label over who it is for, centred like the sheet's other buttons (owner 10-23). */
  .passkey-btn.choice {
    min-height: 3.75rem;
    text-align: center;
    padding: 0.75rem 1rem;
  }

  .passkey-btn.outlined {
    background: transparent;
    color: var(--text);
    border-color: var(--border-hover);
  }

  .passkey-btn.outlined:hover:not(:disabled) {
    background: transparent;
    border-color: var(--text-muted);
  }

  .choice-text {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .choice-sub {
    font-size: 0.8125rem;
    font-weight: 500;
    opacity: 0.8;
  }

  .last-used {
    margin-left: 0.25rem;
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
    font-size: 0.6875rem;
    font-weight: 600;
    background: var(--accent-ink);
    color: var(--accent);
  }

  .passkey-btn:active:not(:disabled) {
    background: var(--accent-press);
  }

  .help-link {
    padding: 0.5rem 0;
    border: 0;
    background: none;
    color: var(--accent-text);
    font: inherit;
    font-size: 0.8125rem;
    cursor: pointer;
  }

  .stays p {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }

  .stays .stays-title {
    color: var(--text);
    font-weight: 600;
  }

  /* The secondary ways in, set apart from the two main choices above them. */
  .more {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.375rem;
    padding-top: 0.625rem;
    border-top: 1px solid var(--border);
  }

  .create-btn {
    padding: 0.5rem;
    font-size: 0.8125rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    border: 1px solid var(--border);
    transition: color var(--transition), border-color var(--transition);
  }

  .create-btn:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--text-muted);
  }

  .create-btn.emphasised {
    color: var(--text);
    border-color: var(--accent);
  }

  .create-btn:disabled {
    opacity: 0.5;
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
