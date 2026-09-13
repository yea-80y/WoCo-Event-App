<!--
  ReferralConfirmBanner — the countersign moment.

  Three reads decide whether it shows, and each answers a question the others
  cannot: the referee's OWN feed says who they claim referred them, the server
  says whether Stripe onboarding is complete (the precondition the campaign
  pays on, and the one fact no chunk carries), and the issuer's confirmation —
  reported by that same call — says whether the credit has already been made.

  The layout draws the edge being recorded: referrer -> this studio. One acid
  action; the confirmed state swaps the rail for the stamp.

  Self-contained lifecycle: hidden until the reads resolve, and hidden for good
  once confirmed, because a confirmation is written once and never moves.
-->
<script lang="ts">
  import type { Hex0x, ReferralConfirmationV1 } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import {
    confirmReferral,
    getReferralStatus,
    type ReferralStatusResponse,
  } from "../../api/campaign.js";
  import { readMyReferralStatement, type MyReferralStatement } from "../../campaign/records.js";
  import { requireAccountForAction } from "../../auth/ensure-action.js";
  import CohortStamp from "./CohortStamp.svelte";

  /** The caller's content-feed owner — prompt-free, and null on a device with
   *  no seed, which is also a device whose statement cannot be read. */
  let myFeed = $state<string | null>(null);
  let statement = $state<MyReferralStatement | null>(null);
  let status = $state<ReferralStatusResponse | null>(null);
  let confirmed = $state<ReferralConfirmationV1 | null>(null);
  let phase = $state<"idle" | "confirming" | "confirmed">("idle");
  let errorMsg = $state<string | null>(null);
  let loading = false;

  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  // Only once a session already exists — a home-screen mount must never trigger
  // a ceremony just to work out what to render.
  //
  // `hasIdentitySeed` as well, for the same reason App.svelte's settle effect
  // depends on it: the statement being read lives on a feed whose owner is
  // derived from the seed, so a device that has none reads nothing and this
  // would otherwise stay blank for the rest of the session — including the
  // session in which the seed finally arrives and the statement is written.
  $effect(() => {
    if (!auth.isAuthenticated || !auth.hasIdentitySeed || loading) return;
    loading = true;
    void load().finally(() => { loading = false; });
  });

  async function load() {
    // The ADDRESS getter, not the signer: this path only reads, and the read
    // must cost the user nothing. Null means no seed on this device yet, so
    // there is no feed to read and nothing to show.
    const feed = await auth.getContentFeedSignerAddress().catch(() => null);
    if (!feed) return;
    myFeed = feed;

    const [claim, resp] = await Promise.all([
      readMyReferralStatement(feed).catch(() => null),
      getReferralStatus().catch(() => null),
    ]);
    statement = claim;
    if (resp?.ok && resp.data) {
      status = resp.data;
      confirmed = resp.data.confirmed;
    }
  }

  const done = $derived(phase === "confirmed" || confirmed !== null);
  // `readOk` is load-bearing: an inconclusive confirmation read must show
  // NOTHING, never the ask. Offering to confirm a referral that may already be
  // recorded invites a second attempt the issuer will refuse as a conflict.
  const ask = $derived(
    !done && statement !== null && status !== null && status.stripeComplete && status.readOk,
  );

  async function confirm() {
    if (!statement || !myFeed || phase === "confirming") return;
    phase = "confirming";
    errorMsg = null;
    try {
      // The ONE ceremony in this flow, and the user pressed the button that
      // asks for it. No `onChain` — nothing here touches a chain.
      const ready = await requireAccountForAction({ context: "creator" });
      if (!ready) { phase = "idle"; return; }

      const resp = await confirmReferral(statement.referrer, myFeed as Hex0x);
      if (!resp.ok || !resp.data) throw new Error(resp.error ?? "Could not confirm the referral.");
      confirmed = resp.data.confirmed;
      phase = "confirmed";
    } catch (err) {
      phase = "idle";
      errorMsg = err instanceof Error ? err.message : "Could not confirm the referral - try again.";
    }
  }
</script>

{#if done || ask}
  <section class="countersign card" aria-live="polite">
    {#if done && confirmed}
      <div class="done">
        <CohortStamp epoch={0} size={64} />
        <div class="done-copy">
          <span class="kicker mono">REFERRAL // RECORDED</span>
          <h2>Referral confirmed</h2>
          <p>
            <span class="mono addr">{short(confirmed.referrer)}</span> now earns from your
            sales - the record is signed, public and permanent.
          </p>
        </div>
      </div>
    {:else if ask && statement}
      <div class="ask">
        <div class="ask-copy">
          <span class="kicker mono">REFERRAL // ONE CONFIRMATION NEEDED</span>
          <h2><span class="mono addr">{short(statement.referrer)}</span> vouched for this studio</h2>
          <p>
            Confirm to credit them. They earn a share of the platform fee on your sales - it
            costs you nothing, now or later.
          </p>
        </div>

        <div class="rail" aria-hidden="true">
          <span class="chip mono">{short(statement.referrer)}</span>
          <span class="edge"><svg viewBox="0 0 60 10" preserveAspectRatio="none"><line x1="0" y1="5" x2="52" y2="5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 3"/><path d="M52 1 L59 5 L52 9 Z" fill="currentColor"/></svg></span>
          <span class="chip chip--you mono">{auth.parent ? short(auth.parent) : "you"}</span>
        </div>

        <div class="act">
          <button class="sign-btn" onclick={confirm} disabled={phase === "confirming"} aria-busy={phase === "confirming"}>
            {phase === "confirming" ? "Confirming…" : "Confirm the referral"}
          </button>
          <span class="free mono">FREE - NO GAS, NO FEES</span>
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
