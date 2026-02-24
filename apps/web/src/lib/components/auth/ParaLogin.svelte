<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import { authenticateWithPara } from "../../auth/para-account.js";

  interface Props {
    oncomplete?: () => void;
  }

  let { oncomplete }: Props = $props();

  let email = $state("");
  let step = $state<"email" | "iframe" | "waiting">("email");
  let iframeUrl = $state<string | null>(null);
  let isNewUser = $state(false);
  let error = $state<string | null>(null);
  let canceled = $state(false);

  async function handleSubmit() {
    if (!email.trim()) return;
    error = null;
    canceled = false;
    step = "waiting";

    try {
      const { address } = await authenticateWithPara(
        email.trim(),
        (url, newUser) => {
          iframeUrl = url;
          isNewUser = newUser;
          step = "iframe";
        },
        () => canceled,
      );

      if (canceled) return;

      const ok = await auth.loginPara(address);
      if (ok) {
        oncomplete?.();
      } else {
        error = "Login failed. Please try again.";
        step = "email";
      }
    } catch (e: any) {
      if (canceled) return;
      console.error("[ParaLogin]", e);
      error = e?.message?.slice(0, 120) || "Authentication failed";
      step = "email";
    }
  }

  function handleCancel() {
    canceled = true;
    iframeUrl = null;
    step = "email";
  }
</script>

{#if step === "email"}
  <div class="para-login">
    <form class="email-form" onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
      <input
        class="email-input"
        type="email"
        placeholder="Email address"
        bind:value={email}
        disabled={auth.busy}
        autocomplete="email"
      />
      <button
        class="para-btn"
        type="submit"
        disabled={!email.trim() || auth.busy}
      >
        {auth.busy ? "Connecting..." : "Continue with Email"}
      </button>
    </form>
    {#if error}
      <p class="error">{error}</p>
    {/if}
    <p class="hint">Powered by Para — no extension needed</p>
  </div>

{:else if step === "iframe" && iframeUrl}
  <div class="para-iframe-wrapper">
    <p class="iframe-label">
      {isNewUser ? "Create your Para wallet" : "Sign in to Para"}
    </p>
    <iframe
      class="para-iframe"
      src={iframeUrl}
      title="Para authentication"
      allow="publickey-credentials-get *; publickey-credentials-create *"
    ></iframe>
    <button class="cancel-btn" onclick={handleCancel}>Cancel</button>
  </div>

{:else if step === "waiting"}
  <div class="para-waiting">
    <span class="spinner"></span>
    <p>Connecting to Para...</p>
  </div>
{/if}

<style>
  .para-login {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .email-form {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .email-input {
    padding: 0.75rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font-size: 0.9375rem;
    outline: none;
    transition: border-color var(--transition);
  }

  .email-input:focus {
    border-color: var(--accent);
  }

  .para-btn {
    padding: 0.75rem;
    font-size: 0.9375rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: #fff;
    transition: background var(--transition);
  }

  .para-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .para-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
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

  /* Iframe step */
  .para-iframe-wrapper {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
  }

  .iframe-label {
    font-size: 0.875rem;
    color: var(--text-muted);
    margin: 0;
  }

  .para-iframe {
    width: 100%;
    height: 420px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
  }

  .cancel-btn {
    font-size: 0.875rem;
    color: var(--text-muted);
    text-decoration: underline;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
  }

  .cancel-btn:hover {
    color: var(--text);
  }

  /* Waiting step */
  .para-waiting {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    padding: 1.5rem 0;
    color: var(--text-muted);
    font-size: 0.9rem;
  }

  .spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
