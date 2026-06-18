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
  import { connectBackupWallet } from "../../wallet/backup-signer.js";

  type Phase = "intro" | "working" | "done" | "error";
  let phase = $state<Phase>("intro");
  let backupAddress = $state<string | null>(null);
  let errorMsg = $state("");
  let step = $state("");

  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const isPasskey = $derived(auth.kind === "passkey");

  async function protect() {
    phase = "working";
    errorMsg = "";
    try {
      step = "Choose your backup wallet…";
      const backup = await connectBackupWallet();
      step = "Confirm with your passkey, then sign in your backup wallet…";
      await auth.setupAccountRecovery(backup);
      backupAddress = backup.address;
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
    {:else if !isPasskey}
      <p class="kicker">Account safety</p>
      <h1>You're already covered</h1>
      <p class="lede">
        This account signs in with your own wallet, so you can always restore it from
        there. Account backups are for passkey sign-ins.
      </p>
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

      {#if phase === "error"}
        <p class="error" role="alert">{errorMsg}</p>
      {/if}

      <button class="btn btn--primary btn--lg cta" onclick={protect} disabled={phase === "working"}>
        {#if phase === "working"}
          <span class="spinner"></span>{step || "Working…"}
        {:else if phase === "error"}
          Try again
        {:else}
          Add a backup wallet
        {/if}
      </button>

      {#if phase !== "working"}
        <p class="footnote">You'll confirm with your passkey, then approve once in your backup wallet.</p>
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

  .cta { width: 100%; justify-content: center; gap: 0.5rem; }

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
