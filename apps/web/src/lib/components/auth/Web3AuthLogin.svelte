<script lang="ts">
  import { onMount } from "svelte";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { isOrphanedCredentialError } from "../../auth/orphaned-credential.js";
  import { isWeb3AuthSignInError } from "../../auth/web3auth-signin-error.js";
  import { SIGN_IN_FAILED_MESSAGE } from "../../auth/signin-failure.js";
  import { WEB3AUTH_POPUP_BLOCKED_MESSAGE } from "../../auth/web3auth-signin-error.js";
  import { signInFailureView, type SignInFailureView } from "../../auth/signin-failure-notice.js";
  import SignInFailureDetails from "./SignInFailureDetails.svelte";
  import type { InAppBrowser } from "../../browser/in-app-browser.js";
  import type { EscapeLink } from "../../browser/in-app-escape.js";
  import { EMAIL_PATTERN, type Web3AuthRoute } from "../../auth/web3auth-direct.js";

  interface Props {
    oncomplete?: () => void;
    /** Attempt started — the modal swaps to its authenticating scene. */
    onstart?: () => void;
    /** Attempt settled (either way) — the modal returns to the picker. */
    onsettle?: () => void;
    /** The app's built-in browser this page is in, if any: a stalled or timed-out
     *  wait then offers the way out beside Try again (owner decision 2026-10-10). */
    inApp: InAppBrowser | null;
    /** This device's last way in was email or social (sign-in-hint.ts). */
    lastUsed?: boolean;
    /** The button opens WoCo's own email / Google / Apple screen instead of Web3Auth's chooser. */
    onexpand?: () => void;
    /** That screen: each button starts its one sign-in directly (web3auth-direct.ts). */
    panel?: boolean;
  }

  let { oncomplete, onstart, onsettle, inApp, lastUsed = false, onexpand, panel = false }: Props = $props();

  /** The last attempt's failure: its line, and (with no words of its own) a code
   *  to screenshot and Web3Auth's redacted reason behind a tap (SignInFailureDetails). */
  let failure = $state<SignInFailureView | null>(null);
  /** The attempt under way, so Try again can wait for the cancelled one to settle. */
  let attempt: Promise<unknown> | null = null;

  // The spinner's time ran out (web3auth-signin-wait.ts): the attempt is still
  // listening for a late result, which signs the person in by itself.
  const stalled = $derived(auth.busy && auth.loginStage === "stalled");

  // Warm the (large) Web3Auth modal SDK while the user reads the options, so
  // the click spends its time on init + the modal, not the bundle download. The
  // panel goes further and builds the instance: its buttons open the sign-in
  // pop-up straight from the tap, and a browser allows that only briefly.
  onMount(() => {
    void auth.prefetchWeb3AuthSdk();
    if (panel) auth.prewarmWeb3AuthSignIn();
  });

  /** The panel's last attempt, so Try again and the blocked pop-up's button repeat it. */
  let lastRoute: Web3AuthRoute | undefined;
  /** The browser kept the sign-in window closed: one tap, a fresh gesture, opens it. */
  let blocked = $state(false);

  let email = $state("");
  let emailError = $state<string | null>(null);

  function submitEmail(e: SubmitEvent) {
    e.preventDefault();
    const value = email.trim();
    if (!EMAIL_PATTERN.test(value)) {
      emailError = "Enter your full email address, like name@example.com.";
      return;
    }
    emailError = null;
    void login({ kind: "email", email: value });
  }

  function choose() {
    if (!onexpand) return void login();
    auth.prewarmWeb3AuthSignIn();
    onexpand();
  }

  /** Desktop only: on a phone a focused field throws the keyboard over the Google and Apple buttons. */
  function focusOnDesktop(node: HTMLInputElement) {
    if (window.matchMedia("(pointer: fine)").matches) node.focus();
  }

  // The link out of an in-app browser, built only when there is one to show.
  let escape = $state<EscapeLink | null>(null);
  $effect(() => {
    if (!inApp || !(stalled || failure)) return;
    void import("../../browser/in-app-escape.js").then(({ escapeLink }) => {
      escape = escapeLink(inApp, new URL(window.location.href));
    });
  });
  const escapeLabel = $derived(
    escape?.kind === "chrome" ? "Open in Chrome" : escape?.kind === "safari" ? "Open in Safari" : "Open in your browser",
  );

  async function login(route?: Web3AuthRoute) {
    failure = null;
    blocked = false;
    lastRoute = route;
    onstart?.();
    const run = auth.loginWeb3Auth(route);
    attempt = run;
    try {
      const ok = await run;
      if (ok) oncomplete?.();
      else {
        // Only when another sign-in was already under way (the store's busy guard).
        failure = { message: SIGN_IN_FAILED_MESSAGE, code: "W3A-busy", detail: null };
      }
    } catch (e: unknown) {
      // An orphaned-credential refusal (#255) is explained by the modal's
      // one-shot notice — don't repeat it here. Closing Web3Auth's own window
      // is a choice, not a failure: say nothing (#803).
      if (isWeb3AuthSignInError(e) && e.cancelled) {
        failure = null;
      } else if (isWeb3AuthSignInError(e) && e.blocked) {
        blocked = true;
      } else if (!isOrphanedCredentialError(e)) {
        failure = signInFailureView(e);
      }
    } finally {
      onsettle?.();
    }
  }

  /** Try again: end the stalled wait (a quiet cancel), then start afresh. */
  async function retry() {
    auth.cancelLogin();
    await attempt;
    await login(lastRoute);
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
  {:else if panel}
    <!-- WoCo's own screen for the sign-ins most people use. Each button starts its
         one sign-in straight away (web3auth-direct.ts); everything else the project
         offers is one tap further, in Web3Auth's own chooser. -->
    <div class="panel">
      {#if blocked}
        <div class="blocked" role="alert">
          <p class="blocked-text">{WEB3AUTH_POPUP_BLOCKED_MESSAGE}</p>
          <button type="button" class="btn btn--primary" onclick={() => login(lastRoute)}>Open the sign-in window</button>
        </div>
      {/if}
      <!-- Every way in on this screen leaves WoCo for Web3Auth (Google's screen says
           "continue to web3auth.io"; the email code is entered on their page): said once,
           in one line, before any tap (owner 2026-10-22). -->
      <p class="handoff-note">Sign-in by <strong>Web3Auth (MetaMask)</strong>. You'll see their name next.</p>
      <!-- Google refuses an app's built-in browser (#812), and the others are no surer
           there: the email box leads, with Web3Auth's own list one tap away below it. -->
      {#if !inApp}
        <button type="button" class="w3a-btn provider" onclick={() => login({ kind: "social", connection: "google" })} disabled={auth.busy}>
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09A6.88 6.88 0 0 1 5.48 12c0-.72.13-1.42.36-2.09V7.07H2.18A11.96 11.96 0 0 0 1 12c0 1.94.47 3.77 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          Continue with Google
        </button>
        <!-- The next sign-ins people know, each one tap, in sight; More is Web3Auth's
             own list (phone, LINE, GitHub ...). Labels sit inside the buttons. -->
        <div class="tiles">
          <button type="button" class="tile" aria-label="Continue with Apple" onclick={() => login({ kind: "social", connection: "apple" })} disabled={auth.busy}>
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C3.79 16.17 4.36 9.53 8.7 9.28c1.28.06 2.15.72 2.9.78.96-.2 1.88-.89 2.9-.8 1.21.11 2.13.6 2.73 1.54-2.48 1.52-1.89 4.87.58 5.8-.48 1.34-.97 2.68-1.76 3.68zM12.03 9.22c-.12-2.37 1.79-4.37 4.03-4.56.27 2.6-2.34 4.68-4.03 4.56z" fill="currentColor"/></svg>
            <span class="tile-label">Apple</span>
          </button>
          <button type="button" class="tile" aria-label="Continue with Facebook" onclick={() => login({ kind: "social", connection: "facebook" })} disabled={auth.busy}>
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z" fill="#0866FF"/></svg>
            <span class="tile-label">Facebook</span>
          </button>
          <button type="button" class="tile" aria-label="Continue with X" onclick={() => login({ kind: "social", connection: "twitter" })} disabled={auth.busy}>
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" fill="currentColor"/></svg>
            <span class="tile-label">X</span>
          </button>
          <button type="button" class="tile" aria-label="Continue with Discord" onclick={() => login({ kind: "social", connection: "discord" })} disabled={auth.busy}>
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" fill="#5865F2"/></svg>
            <span class="tile-label">Discord</span>
          </button>
          <button type="button" class="tile" aria-label="More ways to sign in" onclick={() => login()} disabled={auth.busy}>
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/></svg>
            <span class="tile-label">More</span>
          </button>
        </div>
        <div class="or" aria-hidden="true">or</div>
      {/if}
      <form class="email-form" onsubmit={submitEmail} novalidate>
        <label class="sr-only" for="w3a-email">Email address</label>
        <input
          id="w3a-email"
          type="email"
          bind:value={email}
          oninput={() => (emailError = null)}
          use:focusOnDesktop
          autocomplete="email"
          inputmode="email"
          autocapitalize="none"
          spellcheck="false"
          enterkeyhint="go"
          placeholder="Email address"
          aria-invalid={emailError ? "true" : undefined}
          aria-describedby={emailError ? "w3a-email-error" : undefined}
          disabled={auth.busy}
        />
        {#if emailError}
          <p class="field-error" id="w3a-email-error" role="alert">{emailError}</p>
        {/if}
        <button type="submit" class="btn btn--primary email-submit" disabled={auth.busy}>Email me a code</button>
        <p class="new-note">New here? This creates your account.</p>
      </form>
      {#if failure}
        {#key failure}
          <SignInFailureDetails {failure} />
        {/key}
        {#if escape}
          <a class="open-btn" href={escape.href}>{escapeLabel}</a>
        {/if}
      {/if}
      {#if inApp}
        <button type="button" class="more-ways" onclick={() => login()} disabled={auth.busy}>More ways to sign in</button>
        <p class="hint">Email or social sign-in may not complete in this browser.</p>
      {/if}
      <!-- Web3Auth's own mark, the image its modal ends with: their sign-in, their
           mark, kept now that this screen stands in for the modal (owner 2026-10-22). -->
      <img class="powered-by" src="https://images.web3auth.io/metamask-footer-logo-dark.svg" alt="Powered by MetaMask" width="200" height="36" />
    </div>
  {:else}
    <!-- Web3Auth's modal offers email, SMS and every social sign-in the project
         dashboard enables (15 on 2026-10-20, read from its configuration API).
         The marks are the ones UK buyers know best; "+ more" stands for the rest. -->
    <button class="w3a-btn w3a-btn--main" onclick={choose} disabled={auth.busy}>
      {#if auth.busy}
        <span class="w3a-busy"><span class="spinner"></span>Connecting…</span>
      {:else}
        <span class="w3a-label">Continue with email or social{#if lastUsed}<span class="last-used">Last used</span>{/if}</span>
        <span class="w3a-icons" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="3" y="5" width="18" height="14" rx="1.5" stroke="currentColor" stroke-width="1.8"/>
            <path d="m4 7 8 6 8-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09A6.88 6.88 0 0 1 5.48 12c0-.72.13-1.42.36-2.09V7.07H2.18A11.96 11.96 0 0 0 1 12c0 1.94.47 3.77 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C3.79 16.17 4.36 9.53 8.7 9.28c1.28.06 2.15.72 2.9.78.96-.2 1.88-.89 2.9-.8 1.21.11 2.13.6 2.73 1.54-2.48 1.52-1.89 4.87.58 5.8-.48 1.34-.97 2.68-1.76 3.68zM12.03 9.22c-.12-2.37 1.79-4.37 4.03-4.56.27 2.6-2.34 4.68-4.03 4.56z" fill="currentColor"/>
          </svg>
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z" fill="#0866FF"/>
          </svg>
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" fill="currentColor"/>
          </svg>
          <span class="w3a-more">+ more</span>
        </span>
      {/if}
    </button>
    {#if failure}
      {#key failure}
        <SignInFailureDetails {failure} />
      {/key}
      {#if escape}
        <a class="open-btn" href={escape.href}>{escapeLabel}</a>
      {/if}
    {/if}
    <!-- The button names the sign-ins now; only an app's own browser needs a word more. -->
    {#if inApp}
      <p class="hint">Email or social sign-in may not complete in this browser.</p>
    {/if}
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

  /* The sign-in itself, sized as the passkey button's equal: a real choice, not a
     footnote. (Try again in the stalled panel keeps the plain .w3a-btn.) */
  /* Inside the button: part of its name, not a colour cue beside it. */
  .last-used {
    margin-left: 0.5rem;
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
    font-size: 0.6875rem;
    font-weight: 600;
    background: var(--accent);
    color: var(--accent-ink);
  }

  .w3a-btn--main {
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.75rem;
    font-weight: 700;
    border-color: var(--border-hover);
  }

  .w3a-busy {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }

  .w3a-more {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
  }

  .w3a-icons {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    flex: none;
  }

  .w3a-icons svg {
    width: 18px;
    height: 18px;
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

  /* WoCo's own email / social screen. Brand marks keep their colours; the accent
     is kept for the one main action, Email me a code. */
  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .handoff-note {
    margin: 0 0 0.25rem;
    font-size: 0.8125rem;
    line-height: 1.45;
    color: var(--text-muted);
    text-align: center;
    text-wrap: balance;
  }

  .handoff-note strong {
    color: var(--text-secondary);
    font-weight: 600;
  }

  .tiles {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 0.375rem;
  }

  .tile {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    padding: 0.625rem 0.125rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    color: var(--text);
    transition: border-color var(--transition);
  }

  .tile:hover:not(:disabled) {
    border-color: var(--accent);
  }

  .tile:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .tile svg {
    width: 22px;
    height: 22px;
  }

  /* 10px: "Facebook" fits a tile on a 360px phone (about 50px wide). */
  .tile-label {
    font-size: 0.625rem;
    font-weight: 600;
    color: var(--text-secondary);
    white-space: nowrap;
  }

  .provider {
    gap: 0.625rem;
  }

  .provider svg {
    width: 18px;
    height: 18px;
    flex: none;
  }

  .or {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    margin: 0.25rem 0;
    font-size: 0.75rem;
    color: var(--text-dim);
  }

  .or::before,
  .or::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  .email-form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* 16px: below that, iOS zooms the page when the field takes focus. */
  .email-form input {
    width: 100%;
    font-size: 1rem;
  }

  .email-form input[aria-invalid="true"] {
    border-color: var(--error);
  }

  .field-error {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--error);
  }

  .email-submit {
    width: 100%;
  }

  .new-note {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-muted);
    text-align: center;
  }

  .more-ways {
    display: block;
    margin: 0 auto;
    padding: 0.5rem 0 0;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-secondary);
    transition: color var(--transition);
  }

  .more-ways:hover:not(:disabled) {
    color: var(--accent-text);
  }

  .powered-by {
    align-self: center;
    width: auto;
    height: 30px;
    margin-top: 0.25rem;
  }

  .blocked {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.875rem 1rem;
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--accent-subtle);
  }

  .blocked-text {
    margin: 0;
    font-weight: 600;
    color: var(--text);
  }
</style>
