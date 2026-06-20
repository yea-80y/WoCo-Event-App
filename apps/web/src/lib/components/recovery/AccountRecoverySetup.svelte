<script lang="ts">
  /**
   * "Protect your account" — the user-facing face of passkey account recovery
   * (docs/PASSKEY_RECOVERY_PLAN.md §11). Every crypto concept is hidden: the user
   * just "adds a backup". Under the hood (auth.setupAccountRecovery) this installs
   * the on-chain recovery route pinned to a guardian derived from the backup wallet
   * and escrows the POD seed sealed to that wallet — but none of that is shown.
   *
   * Passkey accounts only: other login kinds already have an external key.
   */
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { connectBackupWallet } from "../../wallet/backup-signer.js";
  import { fetchRecoveryEnvelope, fetchRecoveryByGuardian } from "../../api/recovery.js";

  type Phase = "intro" | "working" | "done" | "error";
  let phase = $state<Phase>("intro");
  let backupAddress = $state<string | null>(null);
  let errorMsg = $state("");
  let step = $state("");

  // "Is a backup already on record?" — read the escrow envelope for this Kernel.
  // CRYPTO NOTE: presence is a HONEST but BOUNDED signal. The PUT is auth-bound to
  // the verified Kernel parent (un-forgeable by a third party) and is the LAST step
  // of setupAccountRecovery (after the irreversible on-chain guardian install), so
  // an envelope existing ⇒ the owner ran setup to completion. It does NOT re-prove
  // the on-chain guardian is still current, nor that the backup key still decrypts
  // — only an actual recovery does (we can't open the ciphertext without a backup
  // signature). So the copy says "on record", never "guaranteed".
  let checking = $state(false);
  let checkDone = $state(false);
  let alreadyProtected = $state(false);

  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  // Don't decide "passkey vs already-covered" until auth has finished restoring —
  // otherwise a logged-in passkey user briefly sees the wrong screen on load.
  const signedIn = $derived(auth.isConnected);
  const isPasskey = $derived(auth.kind === "passkey");

  $effect(() => {
    // Run once, after auth restores and only for passkey accounts. auth.parent is
    // the Kernel address for passkey (invariant: parent === Kernel addr), which is
    // the key the envelope is stored under.
    if (checkDone || checking) return;
    if (!signedIn || !isPasskey) return;
    const kernel = auth.parent;
    if (!kernel) return;
    checking = true;
    (async () => {
      try {
        const env = await fetchRecoveryEnvelope(kernel);
        alreadyProtected = !!env;
      } catch {
        /* read hiccup — fall through to the add-backup CTA, never block setup */
      } finally {
        checking = false;
        checkDone = true;
      }
    })();
  });

  function signIn() {
    loginRequest.request({ context: "attendee" });
  }

  async function protect() {
    phase = "working";
    errorMsg = "";
    try {
      step = "Choose your backup wallet…";
      const backup = await connectBackupWallet();

      // INDEPENDENCE + NO-ACCIDENTAL-DUPLICATE guard (§12.3). A backup must be a
      // DIFFERENT root of trust than the keys that already control this account,
      // and we refuse to silently re-register a wallet that already guards it.
      // (Both are fail-safe checks: the reverse-lookup is an untrusted hint, so a
      // missing index just falls through to the existing behaviour — it never
      // produces a false block on another account's guardian, whose kernel differs.)
      const backupLc = backup.address.toLowerCase();
      const ownKeys = [auth.parent, auth.podAddress].filter(Boolean).map((a) => a!.toLowerCase());
      if (ownKeys.includes(backupLc)) {
        throw new Error(
          "Pick a different wallet — your backup can't be a key that already controls this account.",
        );
      }
      const existing = await fetchRecoveryByGuardian(backup.address).catch(() => null);
      if (existing && auth.parent && existing.kernelAddress.toLowerCase() === auth.parent.toLowerCase()) {
        throw new Error("That wallet is already this account's backup — choose a different wallet.");
      }

      step = "Confirm with your passkey, then sign in your backup wallet…";
      await auth.setupAccountRecovery(backup);
      backupAddress = backup.address;
      alreadyProtected = true;
      phase = "done";
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Something went wrong — please try again";
      phase = "error";
    }
  }
</script>

<section class="wrap">
  <div class="panel" class:panel--done={phase === "done"}>
    <!-- Shield motif -->
    <div class="crest" aria-hidden="true">
      <svg viewBox="0 0 64 72" fill="none">
        <path class="crest-shield" d="M32 3 L59 14 V36 C59 53 47 64 32 69 C17 64 5 53 5 36 V14 Z" />
        {#if phase === "done"}
          <path class="crest-check" d="M21 36 L29 45 L44 26" />
        {:else}
          <path class="crest-key" d="M32 24 a7 7 0 1 0 0.01 0 M32 31 V48 M32 42 H39" />
        {/if}
      </svg>
      <span class="crest-pulse" class:on={phase === "working"}></span>
    </div>

    {#if phase === "done"}
      <p class="kicker kicker--hi">You're protected</p>
      <h1>Backup added</h1>
      <p class="lede">
        If you ever lose this device, you can get back into your account — with your
        tickets and history intact — using your backup wallet.
      </p>
      <div class="backup-chip">
        <span class="dot"></span>
        Backup wallet
        <code>{backupAddress ? short(backupAddress) : ""}</code>
      </div>
      <p class="footnote">Keep that wallet safe. It's the key to getting back in.</p>
    {:else if !signedIn}
      <p class="kicker">Account safety</p>
      <h1>Protect your account</h1>
      <p class="lede">
        Sign in first, then add a backup so you can get back in if you ever lose this device.
      </p>
      <button class="btn btn--primary btn--lg cta" onclick={signIn}>Sign in</button>
    {:else if !isPasskey}
      <p class="kicker">Account safety</p>
      <h1>You're already covered</h1>
      <p class="lede">
        This account signs in with your own wallet, so you can always restore it from
        there. Account backups are for passkey sign-ins.
      </p>
    {:else if phase === "working" || phase === "error"}
      <!-- An add/replace attempt is in flight (or just failed) — show the action UI. -->
      <p class="kicker">Account safety</p>
      <h1>{alreadyProtected ? "Replace your backup" : "Protect your account"}</h1>
      <p class="lede">
        {alreadyProtected
          ? "Connect the wallet you want as your new backup. It replaces the one currently on record."
          : "Add a backup so you can get back in if you ever lose this device."}
      </p>

      {#if phase === "error"}
        <p class="error" role="alert">{errorMsg}</p>
      {/if}

      <button class="btn btn--primary btn--lg cta" onclick={protect} disabled={phase === "working"}>
        {#if phase === "working"}
          <span class="spinner"></span>Working…
        {:else}
          Try again
        {/if}
      </button>

      {#if phase === "working"}
        <p class="step" aria-live="polite">{step || "Working…"}</p>
      {:else}
        <p class="footnote">You'll confirm with your passkey, then approve once in your backup wallet.</p>
      {/if}
    {:else if checking}
      <p class="kicker">Account safety</p>
      <h1>Protect your account</h1>
      <p class="lede step" aria-live="polite">Checking your backup…</p>
    {:else if alreadyProtected}
      <!-- A backup is ON RECORD (see the crypto note in <script>): the owner ran
           setup to completion. Not a proof of live recoverability — that only a
           real recovery confirms — so we don't over-claim. -->
      <p class="kicker kicker--hi">Account safety</p>
      <h1>Backup on record</h1>
      <p class="lede">
        You've set up a backup for this account. If you lose this device, your backup
        wallet can restore it — with your tickets and history intact.
      </p>
      <div class="backup-chip">
        <span class="dot"></span>
        Backup configured
      </div>
      <p class="footnote">
        The only way to be fully sure is to run a recovery on another device. You can
        also replace your backup with a different wallet.
      </p>
      <button class="btn btn--ghost cta" onclick={protect}>Replace backup wallet</button>
    {:else}
      <p class="kicker">Account safety</p>
      <h1>Protect your account</h1>
      <p class="lede">
        Add a backup so you can get back in if you ever lose this device. It takes a few
        seconds, and your tickets and account stay safe.
      </p>

      <ul class="reasons">
        <li><span class="tick">✓</span> Recover on a new phone or laptop</li>
        <li><span class="tick">✓</span> Your tickets and history come back with you</li>
        <li><span class="tick">✓</span> Only your backup wallet can do it — no one else</li>
      </ul>

      <button class="btn btn--primary btn--lg cta" onclick={protect}>Add a backup wallet</button>
      <p class="footnote">You'll confirm with your passkey, then approve once in your backup wallet.</p>
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
    width: min(28rem, 100%);
    background:
      radial-gradient(120% 90% at 50% -10%, var(--accent-subtle), transparent 60%),
      var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 2.5rem 2rem 2rem;
    text-align: center;
    overflow: hidden;
    animation: rise 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  .panel::before {
    /* faint grain/texture line at the crown */
    content: "";
    position: absolute;
    inset: 0 0 auto 0;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
    opacity: 0.5;
  }
  .panel--done {
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  }

  .crest {
    position: relative;
    width: 84px;
    height: 84px;
    margin: 0 auto 1.25rem;
    display: grid;
    place-items: center;
    animation: rise 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) both;
    animation-delay: 0.05s;
  }
  .crest svg { width: 64px; height: 72px; overflow: visible; }
  .crest-shield {
    fill: var(--accent-subtle);
    stroke: var(--accent);
    stroke-width: 2;
    stroke-linejoin: round;
  }
  .crest-key {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2.5;
    stroke-linecap: round;
  }
  .crest-check {
    fill: none;
    stroke: var(--accent);
    stroke-width: 3.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: 48;
    stroke-dashoffset: 48;
    animation: draw 0.5s 0.1s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
  }
  .crest-pulse {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 1px solid var(--accent);
    opacity: 0;
  }
  .crest-pulse.on { animation: pulse 1.4s ease-out infinite; }

  h1 {
    font-family: var(--font-display);
    font-size: 1.65rem;
    letter-spacing: -0.02em;
    margin: 0.25rem 0 0.6rem;
  }
  .kicker { justify-content: center; display: inline-flex; }
  .lede {
    color: var(--text-secondary);
    line-height: 1.55;
    font-size: 0.97rem;
    margin: 0 auto 1.4rem;
    max-width: 24rem;
  }

  .reasons {
    list-style: none;
    margin: 0 0 1.5rem;
    padding: 0;
    display: grid;
    gap: 0.55rem;
    text-align: left;
  }
  .reasons li {
    display: flex;
    gap: 0.6rem;
    align-items: flex-start;
    font-size: 0.92rem;
    color: var(--text-secondary);
  }
  .tick {
    color: var(--accent-ink);
    background: var(--accent);
    border-radius: 50%;
    width: 1.1rem;
    height: 1.1rem;
    display: grid;
    place-items: center;
    font-size: 0.7rem;
    flex: none;
    margin-top: 0.1rem;
  }

  .cta { width: 100%; justify-content: center; gap: 0.5rem; white-space: nowrap; }

  .step {
    font-size: 0.85rem;
    color: var(--text-secondary);
    line-height: 1.45;
    margin: 0.8rem auto 0;
    max-width: 22rem;
  }

  .backup-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
    color: var(--text-secondary);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 0.5rem 0.8rem;
    margin: 0.4rem 0 1rem;
  }
  .backup-chip code { font-family: var(--font-mono); color: var(--text); }
  .backup-chip .dot {
    width: 0.5rem; height: 0.5rem; border-radius: 50%;
    background: var(--accent); box-shadow: 0 0 8px var(--accent);
  }

  .footnote { font-size: 0.8rem; color: var(--text-muted); margin: 0; }
  .error {
    color: var(--error);
    background: var(--error-subtle);
    border: 1px solid color-mix(in srgb, var(--error) 35%, transparent);
    border-radius: var(--radius-md);
    padding: 0.6rem 0.8rem;
    font-size: 0.88rem;
    margin: 0 0 1rem;
  }

  .spinner {
    width: 0.9rem; height: 0.9rem; flex: none;
    border: 2px solid color-mix(in srgb, var(--accent-ink) 35%, transparent);
    border-top-color: var(--accent-ink);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  @keyframes draw { to { stroke-dashoffset: 0; } }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse {
    0% { opacity: 0.5; transform: scale(0.7); }
    100% { opacity: 0; transform: scale(1.25); }
  }
  @media (prefers-reduced-motion: reduce) {
    .panel, .crest, .crest-check, .crest-pulse.on { animation: none; }
    .crest-check { stroke-dashoffset: 0; }
  }
</style>
