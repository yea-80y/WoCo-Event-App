<script lang="ts">
  /**
   * "Recover my account" — the locked-out user's entry point (no session; they
   * may have lost their device). All crypto is hidden: they connect the backup
   * wallet they added during setup, we confirm a protected account exists, then
   * re-key it to this device.
   *
   * The final step is IRREVERSIBLE (on-chain signer rotation + a fresh passkey on
   * this device + restoring the identity key from escrow), so it runs only after
   * an explicit confirmation. The on-chain rotation is proven on Arb Sepolia
   * (recovery-spike-caller-hook.ts) and the escrow round-trip by
   * recovery-escrow-spike.ts; docs/PASSKEY_RECOVERY_PLAN.md still gates ADVERTISING
   * this for funds-holding accounts on the owner's own live end-to-end test.
   */
  import { auth } from "../../auth/auth-store.svelte.js";
  import { connectBackupWallet, type BackupWallet } from "../../wallet/backup-signer.js";
  import { fetchRecoveryEnvelope } from "../../api/recovery.js";

  type Phase =
    | "intro"
    | "connecting"
    | "checking"
    | "found"
    | "none"
    | "restoring"
    | "recovered"
    | "error";
  let phase = $state<Phase>("intro");
  let backup = $state<BackupWallet | null>(null);
  let account = $state("");
  let errorMsg = $state("");
  let restoreStep = $state("");

  const backupAddress = $derived(backup?.address ?? null);
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const validAccount = $derived(/^0x[a-fA-F0-9]{40}$/.test(account.trim()));

  async function connect() {
    phase = "connecting";
    errorMsg = "";
    try {
      backup = await connectBackupWallet();
      phase = "intro";
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Couldn't connect your wallet";
      phase = "error";
    }
  }

  async function check() {
    if (!validAccount) return;
    phase = "checking";
    errorMsg = "";
    try {
      const env = await fetchRecoveryEnvelope(account.trim());
      phase = env ? "found" : "none";
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Couldn't check that account";
      phase = "error";
    }
  }

  async function restore() {
    if (!backup) return;
    phase = "restoring";
    errorMsg = "";
    try {
      restoreStep = "Create a new passkey on this device…";
      // recoverAndRekey runs the full ceremony; the new-passkey prompt fires inside.
      await auth.recoverAndRekey({ backup, targetAddress: account.trim() });
      phase = "recovered";
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Recovery couldn't be completed — please try again";
      phase = "error";
    }
  }

  function goToAccount() {
    window.location.hash = "#/";
  }
</script>

<section class="wrap">
  <div class="panel">
    <div class="crest" aria-hidden="true">
      <svg viewBox="0 0 64 72" fill="none">
        <path class="crest-shield" d="M32 3 L59 14 V36 C59 53 47 64 32 69 C17 64 5 53 5 36 V14 Z" />
        <path class="crest-arrow" d="M32 47 V25 M24 33 L32 25 L40 33" />
      </svg>
    </div>

    {#if phase === "recovered"}
      <p class="kicker kicker--hi">You're back in</p>
      <h1>Account recovered</h1>
      <p class="lede">
        <code>{short(account.trim())}</code> now belongs to this device — with your tickets
        and history intact. Your old device can no longer access it.
      </p>
      <button class="btn btn--primary btn--lg cta" onclick={goToAccount}>Go to my account</button>
    {:else}
      <p class="kicker">Account recovery</p>
      <h1>Get back into your account</h1>
      <p class="lede">
        Lost your device? Connect the backup wallet you saved earlier and we'll restore
        your access — with your tickets and history.
      </p>

      <!-- Step 1: backup wallet -->
      <div class="step" class:done={!!backupAddress}>
        <span class="num">{backupAddress ? "✓" : "1"}</span>
        <div class="step-body">
          <p class="step-title">Connect your backup wallet</p>
          {#if backupAddress}
            <code class="addr">{short(backupAddress)}</code>
          {:else}
            <button class="btn btn--ghost" onclick={connect} disabled={phase === "connecting"}>
              {#if phase === "connecting"}<span class="spinner"></span>Connecting…{:else}Connect wallet{/if}
            </button>
          {/if}
        </div>
      </div>

      <!-- Step 2: account -->
      <div class="step" class:muted={!backupAddress}>
        <span class="num">{phase === "found" ? "✓" : "2"}</span>
        <div class="step-body">
          <p class="step-title">Which account?</p>
          <p class="step-hint">Paste your account address (it starts with 0x).</p>
          <div class="row">
            <input
              class="input"
              placeholder="0x…"
              bind:value={account}
              disabled={!backupAddress || phase === "checking" || phase === "restoring"}
              spellcheck="false"
            />
            <button
              class="btn btn--primary"
              onclick={check}
              disabled={!backupAddress || !validAccount || phase === "checking" || phase === "restoring"}
            >
              {#if phase === "checking"}<span class="spinner spinner--ink"></span>{:else}Find{/if}
            </button>
          </div>
        </div>
      </div>

      {#if phase === "error"}
        <p class="error" role="alert">{errorMsg}</p>
      {/if}

      {#if phase === "found" || phase === "restoring"}
        <div class="result result--ok">
          <p class="result-title">Protected account found ✓</p>
          <p class="result-body">
            We can restore <code>{short(account.trim())}</code> to this device using your backup.
          </p>
          <p class="warn">
            This is permanent: you'll create a new passkey on <strong>this</strong> device and your
            <strong>old device's</strong> passkey will stop working for this account.
          </p>
          <button class="btn btn--primary btn--lg" onclick={restore} disabled={phase === "restoring"}>
            {#if phase === "restoring"}
              <span class="spinner"></span>{restoreStep || "Restoring…"}
            {:else}
              Restore my account
            {/if}
          </button>
        </div>
      {:else if phase === "none"}
        <div class="result">
          <p class="result-title">No backup found for that account</p>
          <p class="result-body">
            Double-check the address, or make sure you set up a backup on your old device.
            If you never added one, recovery isn't possible for this account.
          </p>
        </div>
      {/if}
    {/if}
  </div>
</section>

<style>
  .wrap {
    min-height: 100%;
    display: grid;
    place-items: center;
    padding: clamp(1.5rem, 5vw, 4rem) 1.25rem;
  }
  .panel {
    position: relative;
    width: min(30rem, 100%);
    background:
      radial-gradient(120% 90% at 50% -10%, var(--accent-subtle), transparent 60%),
      var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 2.5rem 2rem 2rem;
    text-align: center;
    animation: rise 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  .panel::before {
    content: "";
    position: absolute;
    inset: 0 0 auto 0;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
    opacity: 0.5;
  }

  .crest { width: 72px; height: 72px; margin: 0 auto 1rem; }
  .crest svg { width: 60px; height: 68px; overflow: visible; }
  .crest-shield { fill: var(--accent-subtle); stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; }
  .crest-arrow { fill: none; stroke: var(--accent); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }

  h1 { font-family: var(--font-display); font-size: 1.6rem; letter-spacing: -0.02em; margin: 0.25rem 0 0.6rem; }
  .kicker { justify-content: center; display: inline-flex; }
  .lede { color: var(--text-secondary); line-height: 1.55; font-size: 0.95rem; margin: 0 auto 1.75rem; max-width: 24rem; }

  .step {
    display: flex;
    gap: 0.9rem;
    text-align: left;
    align-items: flex-start;
    padding: 1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-input);
    margin-bottom: 0.75rem;
    transition: opacity var(--transition), border-color var(--transition);
  }
  .step.muted { opacity: 0.5; }
  .step.done { border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
  .num {
    flex: none;
    width: 1.6rem; height: 1.6rem;
    display: grid; place-items: center;
    border-radius: 50%;
    font-family: var(--font-mono);
    font-size: 0.8rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border-hover);
    color: var(--text-secondary);
  }
  .step.done .num { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  .step-body { flex: 1; min-width: 0; }
  .step-title { margin: 0.1rem 0 0.4rem; font-weight: 600; font-size: 0.95rem; }
  .step-hint { margin: 0 0 0.6rem; font-size: 0.83rem; color: var(--text-muted); }
  .addr { font-family: var(--font-mono); color: var(--accent-text); font-size: 0.9rem; }

  .row { display: flex; gap: 0.5rem; }
  .row .input { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 0.85rem; }
  .row .btn { flex: none; }

  .result { margin-top: 0.5rem; text-align: left; padding: 1rem; border-radius: var(--radius-md); border: 1px solid var(--border); }
  .result--ok { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); background: var(--accent-subtle); }
  .result-title { margin: 0 0 0.4rem; font-weight: 600; }
  .result-body { margin: 0 0 1rem; font-size: 0.88rem; color: var(--text-secondary); line-height: 1.5; }
  .result-body code, .result code { font-family: var(--font-mono); color: var(--text); }
  .result .btn { width: 100%; justify-content: center; gap: 0.5rem; }

  .warn {
    text-align: left;
    font-size: 0.84rem;
    line-height: 1.5;
    color: var(--text-secondary);
    background: var(--bg-input);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
    border-radius: var(--radius-md);
    padding: 0.6rem 0.8rem;
    margin: 0 0 1rem;
  }
  .warn strong { color: var(--text); }

  .kicker--hi { color: var(--accent-text); }
  .cta { width: 100%; justify-content: center; }

  .error {
    color: var(--error);
    background: var(--error-subtle);
    border: 1px solid color-mix(in srgb, var(--error) 35%, transparent);
    border-radius: var(--radius-md);
    padding: 0.6rem 0.8rem; font-size: 0.88rem; margin: 0.25rem 0 0;
  }

  .spinner {
    width: 0.85rem; height: 0.85rem; flex: none; display: inline-block;
    vertical-align: -1px; margin-right: 0.4rem;
    border: 2px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  .spinner--ink { border-color: color-mix(in srgb, var(--accent-ink) 35%, transparent); border-top-color: var(--accent-ink); margin: 0; }

  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .panel { animation: none; } }
</style>
