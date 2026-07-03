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
  import { connectBackupWallet, connectWeb3AuthBackup, connectPasskeyBackup, type BackupWallet } from "../../wallet/backup-signer.js";
  import { fetchRecoveryStatus, fetchRecoveryByGuardian } from "../../api/recovery.js";
  import { resolveSubEnsAddress } from "../../api/sub-ens.js";

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
  // `account` is always the resolved hex address (what check/restore need).
  // `manualInput` is the raw text the user types — a WoCo name OR a 0x address.
  let account = $state("");
  let manualInput = $state("");
  let manualOpen = $state(false);
  let displayName = $state<string | null>(null);
  let errorMsg = $state("");
  let restoreStep = $state("");
  // Forward sign-in credential for the recovered account (owner decision 2026-07-02):
  // "email" keeps the account on email/social (a fresh Web3Auth login becomes the new
  // Kernel owner); "passkey" mints a device passkey. This is a UX choice of the going-
  // forward credential — the escrow mechanism that unlocks the account is unchanged.
  let newOwnerKind = $state<"email" | "passkey">("email");

  const backupAddress = $derived(backup?.address ?? null);
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const manualReady = $derived(manualInput.trim().length > 0);

  async function connectWith(method: "email" | "wallet" | "passkey") {
    phase = "connecting";
    errorMsg = "";
    try {
      backup = method === "email"
        ? await connectWeb3AuthBackup()
        : method === "passkey"
        // mode "get": discoverable picker re-derives the SAME guardian key that
        // setup's "create" minted — the user selects their "WoCo Backup" passkey.
        ? await connectPasskeyBackup("get")
        : await connectBackupWallet();
      phase = "intro";
      await autoFind();
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Couldn't connect your backup";
      phase = "error";
    }
  }

  // Derive the guardian address from the connected backup (same deterministic
  // config as setup) and look up the account it protects. Best-effort: if the
  // hint is missing/poisoned the user falls back to manual entry, and recovery's
  // escrow-decrypt guard means a wrong hit can never cause harm.
  async function autoFind() {
    if (!backup) return;
    try {
      const { deriveGuardianAddress } = await import("../../auth/kernel-account.js");
      const guardian = await deriveGuardianAddress({
        signers: [{ address: backup.address as `0x${string}`, weight: 100 }],
        threshold: 100,
      });
      const hit = await fetchRecoveryByGuardian(guardian);
      if (hit?.kernelAddress) {
        displayName = hit.label ? `${hit.label}.woco.eth` : null;
        await checkAddress(hit.kernelAddress.toLowerCase());
        return;
      }
    } catch {
      /* auto-find is a convenience; fall through to manual entry */
    }
    manualOpen = true; // nothing auto-found → reveal the manual box
  }

  // Manual fallback: accept a WoCo name (resolve via sub-ENS) or a raw address.
  async function findManually() {
    const raw = manualInput.trim();
    if (!raw) return;
    phase = "checking";
    errorMsg = "";
    try {
      let addr: string | null = null;
      let name: string | null = null;
      if (/^0x[a-fA-F0-9]{40}$/.test(raw)) {
        addr = raw.toLowerCase();
      } else {
        addr = await resolveSubEnsAddress(raw);
        if (addr) name = raw.toLowerCase().endsWith(".woco.eth") ? raw.toLowerCase() : `${raw.toLowerCase()}.woco.eth`;
      }
      if (!addr) {
        phase = "none";
        return;
      }
      displayName = name;
      await checkAddress(addr);
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Couldn't check that account";
      phase = "error";
    }
  }

  // Confirm a protected account exists for `addr` and move to the found/none state.
  // Presence hint only (§13): the authoritative check is the guardian-SOC decrypt
  // inside recoverAndRekey, which cannot run until the backup wallet signs.
  async function checkAddress(addr: string) {
    account = addr;
    phase = "checking";
    errorMsg = "";
    try {
      const status = await fetchRecoveryStatus(addr);
      phase = status?.configured ? "found" : "none";
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
      restoreStep = "Starting recovery…";
      // recoverAndRekey emits a message right before each wallet prompt so the
      // user knows what they're approving (the guardian signature is an opaque hash).
      await auth.recoverAndRekey({
        backup,
        targetAddress: account.trim(),
        newOwnerKind: newOwnerKind === "email" ? "web3auth" : "passkey",
        onProgress: (m) => { restoreStep = m; },
      });
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

      <!-- Step 1: backup — email or crypto wallet chooser -->
      <div class="step" class:done={!!backupAddress}>
        <span class="num">{backupAddress ? "✓" : "1"}</span>
        <div class="step-body">
          <p class="step-title">Connect your backup</p>
          {#if backupAddress}
            <code class="addr">{short(backupAddress)}</code>
          {:else if phase === "connecting"}
            <p class="conn-hint"><span class="spinner"></span> Connecting…</p>
          {:else}
            <p class="step-hint">How did you add your backup?</p>
            <div class="connect-opts">
              <button
                class="connect-btn"
                onclick={() => connectWith("email")}
                disabled={phase === "connecting" || phase === "restoring"}
              >
                <svg viewBox="0 0 18 14" fill="none" stroke="currentColor" stroke-width="1.6"
                     stroke-linecap="round" stroke-linejoin="round" width="16" height="13" aria-hidden="true">
                  <rect x="1" y="1" width="16" height="12" rx="2"/>
                  <polyline points="1,1.5 9,8.5 17,1.5"/>
                </svg>
                Email
              </button>
              <button
                class="connect-btn"
                onclick={() => connectWith("passkey")}
                disabled={phase === "connecting" || phase === "restoring"}
              >
                <svg viewBox="0 0 18 14" fill="none" stroke="currentColor" stroke-width="1.6"
                     stroke-linecap="round" stroke-linejoin="round" width="16" height="13" aria-hidden="true">
                  <circle cx="6" cy="7" r="3.5"/>
                  <path d="M9.5 7 H17 M14 7 V10 M17 7 V9.5"/>
                </svg>
                Passkey
              </button>
              <button
                class="connect-btn"
                onclick={() => connectWith("wallet")}
                disabled={phase === "connecting" || phase === "restoring"}
              >
                <svg viewBox="0 0 18 14" fill="none" stroke="currentColor" stroke-width="1.6"
                     stroke-linecap="round" stroke-linejoin="round" width="16" height="13" aria-hidden="true">
                  <rect x="1" y="4" width="16" height="9" rx="2"/>
                  <path d="M5 4V3a2 2 0 014 0v1"/>
                  <circle cx="13" cy="8.5" r="1.4" fill="currentColor" stroke="none"/>
                </svg>
                Crypto wallet
              </button>
            </div>
          {/if}
        </div>
      </div>

      <!-- Step 2: account — auto-found from the backup wallet, with manual fallback -->
      <div class="step" class:muted={!backupAddress}>
        <span class="num">{phase === "found" ? "✓" : "2"}</span>
        <div class="step-body">
          <p class="step-title">Which account?</p>
          {#if account && !manualOpen}
            <p class="found-hint">
              {#if displayName}
                <strong>{displayName}</strong> · <code class="addr">{short(account)}</code>
              {:else}
                <code class="addr">{short(account)}</code>
              {/if}
            </p>
            <button
              type="button"
              class="linkish"
              onclick={() => { manualOpen = true; account = ""; displayName = null; phase = "intro"; }}
            >
              Not your account? Enter it manually
            </button>
          {:else}
            <p class="step-hint">Enter your WoCo name (e.g. you.woco.eth) or your account address.</p>
            <div class="row">
              <input
                class="input"
                placeholder="you.woco.eth or 0x…"
                bind:value={manualInput}
                disabled={!backupAddress || phase === "checking" || phase === "restoring"}
                spellcheck="false"
              />
              <button
                class="btn btn--primary"
                onclick={findManually}
                disabled={!backupAddress || !manualReady || phase === "checking" || phase === "restoring"}
              >
                {#if phase === "checking"}<span class="spinner spinner--ink"></span>{:else}Find{/if}
              </button>
            </div>
          {/if}
        </div>
      </div>

      {#if phase === "error"}
        <p class="error" role="alert">{errorMsg}</p>
      {/if}

      {#if phase === "found" || phase === "restoring"}
        <div class="result result--ok">
          <p class="result-title">Protected account found ✓</p>
          <p class="result-body">
            We can restore
            {#if displayName}<strong>{displayName}</strong> (<code>{short(account)}</code>){:else}<code>{short(account)}</code>{/if}
            to this device using your backup.
          </p>
          <fieldset class="owner-choice" disabled={phase === "restoring"}>
            <legend>How do you want to sign in from now on?</legend>
            <label class="owner-opt" class:sel={newOwnerKind === "email"}>
              <input type="radio" name="newowner" value="email" bind:group={newOwnerKind} />
              <span class="owner-opt-body">
                <strong>Email or social</strong>
                <span class="owner-opt-hint">Log in the same easy way. Recommended.</span>
              </span>
            </label>
            <label class="owner-opt" class:sel={newOwnerKind === "passkey"}>
              <input type="radio" name="newowner" value="passkey" bind:group={newOwnerKind} />
              <span class="owner-opt-body">
                <strong>Passkey on this device</strong>
                <span class="owner-opt-hint">Face/touch unlock, tied to this device.</span>
              </span>
            </label>
          </fieldset>
          <p class="warn">
            This is permanent: you'll set up your
            {newOwnerKind === "email" ? "email/social sign-in" : "a new passkey"}
            on <strong>this</strong> device and your <strong>old device's</strong> sign-in will
            stop working for this account.
          </p>
          <p class="restore-note">
            You'll {newOwnerKind === "email" ? "log in with email/social, then " : ""}approve
            <strong>two prompts in your backup wallet</strong>: one to unlock your data,
            then one to authorise moving the account to this device.
          </p>
          <button class="btn btn--primary btn--lg restore-cta" onclick={restore} disabled={phase === "restoring"}>
            {#if phase === "restoring"}
              <span class="spinner"></span>Restoring…
            {:else}
              Restore my account
            {/if}
          </button>
          {#if phase === "restoring"}
            <p class="restore-step" aria-live="polite">{restoreStep || "Restoring…"}</p>
          {/if}
        </div>
      {:else if phase === "none"}
        <div class="result">
          <p class="result-title">No backup found for that account</p>
          <p class="result-body">
            Double-check the name or address, or make sure you set up a backup on your old device.
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

  .connect-opts {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }
  .connect-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.45rem 0.8rem;
    font-size: 0.83rem;
    font-weight: 500;
    color: var(--text);
    background: var(--bg-elevated);
    border: 1px solid var(--border-hover);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: border-color 0.12s, color 0.12s;
  }
  .connect-btn svg { color: var(--accent); }
  .connect-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent-text); }
  .connect-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .conn-hint {
    display: flex; align-items: center; gap: 0.4rem;
    font-size: 0.84rem; color: var(--text-secondary); margin: 0.25rem 0 0;
  }

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

  .owner-choice {
    border: none;
    margin: 0 0 1rem;
    padding: 0;
    display: grid;
    gap: 0.45rem;
    text-align: left;
  }
  .owner-choice legend {
    padding: 0;
    margin: 0 0 0.5rem;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text);
  }
  .owner-opt {
    display: flex;
    gap: 0.6rem;
    align-items: flex-start;
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-input);
    cursor: pointer;
    transition: border-color 0.12s, background 0.12s;
  }
  .owner-opt.sel {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--bg-input));
  }
  .owner-opt input { margin-top: 0.15rem; accent-color: var(--accent); flex: none; }
  .owner-opt-body { display: flex; flex-direction: column; gap: 0.1rem; }
  .owner-opt-body strong { font-size: 0.88rem; color: var(--text); font-weight: 600; }
  .owner-opt-hint { font-size: 0.78rem; color: var(--text-muted); line-height: 1.35; }
  .owner-choice:disabled { opacity: 0.6; }

  .kicker--hi { color: var(--accent-text); }
  .cta { width: 100%; justify-content: center; }

  .error {
    color: var(--error);
    background: var(--error-subtle);
    border: 1px solid color-mix(in srgb, var(--error) 35%, transparent);
    border-radius: var(--radius-md);
    padding: 0.6rem 0.8rem; font-size: 0.88rem; margin: 0.25rem 0 0;
  }

  .found-hint { margin: 0 0 0.4rem; font-size: 0.9rem; color: var(--text-secondary); }
  .found-hint strong { color: var(--text); }
  .linkish {
    background: none; border: none; padding: 0; cursor: pointer;
    font-size: 0.8rem; color: var(--text-muted); text-decoration: underline;
    text-underline-offset: 2px;
  }
  .linkish:hover { color: var(--text-secondary); }

  .restore-note {
    font-size: 0.82rem; color: var(--text-muted); line-height: 1.45;
    margin: 0 0 0.9rem; text-align: left;
  }
  .restore-note strong { color: var(--text-secondary); }

  .restore-cta { white-space: nowrap; }
  .restore-step {
    font-size: 0.85rem; color: var(--text-secondary); line-height: 1.45;
    margin: 0.7rem 0 0; text-align: center;
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
