<!--
  ReferralConfirmBanner — the countersign moment. Shown on the creator home
  only when the server says readyToAttest (pending attribution + Stripe
  onboarding complete). The layout draws the exact graph edge the merchant is
  about to write on-chain: referrer → this studio. One acid action; the
  confirmed state swaps the rail for the stamp.

  Self-contained lifecycle: hidden until status resolves, disappears for good
  once confirmed (next load: status.confirmed → never readyToAttest again).
-->
<script lang="ts">
  import type { Hex0x, ReferralStatus } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { getReferralStatus } from "../../api/campaign.js";
  import CohortStamp from "./CohortStamp.svelte";

  let status = $state<ReferralStatus | null>(null);
  let phase = $state<"idle" | "signing" | "confirmed">("idle");
  let errorMsg = $state<string | null>(null);

  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  // Only fetch once a session already exists — a home-screen mount must never
  // trigger a signing prompt just to check referral state.
  $effect(() => {
    if (!auth.isAuthenticated) return;
    getReferralStatus().then((resp) => {
      if (resp.ok && resp.data) status = resp.data;
    }).catch(() => {});
  });

  const visible = $derived(
    (status?.readyToAttest && phase !== "confirmed") || phase === "confirmed",
  );

  async function countersign() {
    if (!status?.pending || phase === "signing") return;
    phase = "signing";
    errorMsg = null;
    try {
      // Wallet/kernel attest machinery loads only when the button is pressed.
      const { confirmReferral } = await import("../../eas/attest-referral.js");
      status = await confirmReferral(status.pending.referrer as Hex0x);
      phase = "confirmed";
    } catch (err) {
      phase = "idle";
      errorMsg = err instanceof Error ? err.message : "Signing failed — try again.";
    }
  }
</script>

{#if visible}
  <section class="countersign card" aria-live="polite">
    {#if phase === "confirmed" && status?.confirmed}
      <div class="done">
        <CohortStamp epoch={0} size={64} />
        <div class="done-copy">
          <span class="kicker mono">REFERRAL // RECORDED</span>
          <h2>Countersigned on-chain</h2>
          <p>
            <span class="mono addr">{short(status.confirmed.referrer)}</span> now earns from your
            sales — the record is public, permanent, and theirs.
          </p>
        </div>
      </div>
    {:else if status?.pending}
      <div class="ask">
        <div class="ask-copy">
          <span class="kicker mono">REFERRAL // ONE SIGNATURE NEEDED</span>
          <h2><span class="mono addr">{short(status.pending.referrer)}</span> vouched for this studio</h2>
          <p>
            Countersign to credit them on-chain. They earn a share of the platform fee on your
            sales — it costs you nothing, now or later.
          </p>
        </div>

        <div class="rail" aria-hidden="true">
          <span class="chip mono">{short(status.pending.referrer)}</span>
          <span class="edge"><svg viewBox="0 0 60 10" preserveAspectRatio="none"><line x1="0" y1="5" x2="52" y2="5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 3"/><path d="M52 1 L59 5 L52 9 Z" fill="currentColor"/></svg></span>
          <span class="chip chip--you mono">{auth.parent ? short(auth.parent) : "you"}</span>
        </div>

        <div class="act">
          <button class="sign-btn" onclick={countersign} disabled={phase === "signing"} aria-busy={phase === "signing"}>
            {phase === "signing" ? "Signing…" : "Countersign on-chain"}
          </button>
          <span class="free mono">FREE — NO GAS, NO FEES</span>
        </div>

        {#if errorMsg}
          <p class="error" role="alert">{errorMsg}</p>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  .countersign {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius-md);
    padding: 1.25rem 1.5rem;
    margin-bottom: 1.5rem;
  }
  .kicker {
    font-size: 0.6875rem;
    letter-spacing: 0.14em;
    color: var(--accent-text);
  }
  h2 {
    font-family: var(--font-display);
    font-size: 1.125rem;
    margin: 0.375rem 0 0.25rem;
    color: var(--text);
  }
  p {
    margin: 0;
    font-size: 0.875rem;
    color: var(--text-secondary);
    max-width: 52ch;
  }
  .addr { color: var(--text); }
  .mono { font-family: var(--font-mono); }

  .rail {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 1rem 0;
  }
  .chip {
    font-size: 0.75rem;
    padding: 0.3125rem 0.625rem;
    border: 1px solid var(--border-hover);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    background: var(--bg-input);
  }
  .chip--you {
    border-color: var(--accent);
    color: var(--accent-text);
    background: var(--accent-subtle);
  }
  .edge {
    color: var(--text-dim);
    flex: 0 1 4rem;
    display: flex;
  }
  .edge svg { width: 100%; height: 10px; }

  .act {
    display: flex;
    align-items: center;
    gap: 0.875rem;
    flex-wrap: wrap;
  }
  .sign-btn {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 0.875rem;
    padding: 0.625rem 1.25rem;
    background: var(--accent);
    color: var(--accent-ink);
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background var(--transition);
  }
  .sign-btn:hover:not(:disabled) { background: var(--accent-hover); }
  .sign-btn:active:not(:disabled) { background: var(--accent-press); }
  .sign-btn:disabled { opacity: 0.6; cursor: default; }
  .sign-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .free {
    font-size: 0.625rem;
    letter-spacing: 0.12em;
    color: var(--text-muted);
  }
  .error {
    margin-top: 0.75rem;
    font-size: 0.8125rem;
    color: var(--error);
  }

  .done {
    display: flex;
    align-items: center;
    gap: 1.25rem;
  }
  .done-copy h2 { margin-top: 0.25rem; }

  @media (max-width: 560px) {
    .done { flex-direction: column; align-items: flex-start; }
  }
</style>
