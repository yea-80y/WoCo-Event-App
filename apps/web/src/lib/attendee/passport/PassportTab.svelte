<!--
  PassportTab — the owner's tickets, credits and stamps, inside Profile.

  Tickets are private: Profile renders this tab only for the account's owner.
  They are the account's linked tickets, read from the unlock status, which
  needs a session already on this device; without one the tab offers a tap to
  set it up rather than opening on a signing prompt.
-->
<script lang="ts">
  import type { BadgeV1 } from "@woco/shared";
  import { lookupSubject, currentEra, WOCO_SUBJECTS } from "@woco/shared";
  import { onMount, untrack } from "svelte";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { navigate } from "../../router/router.svelte.js";
  import CohortStamp from "../../components/campaign/CohortStamp.svelte";
  import { gate } from "../gate/gate.svelte.js";
  import PassportTicket from "./PassportTicket.svelte";
  import { passportState } from "./passport-state.svelte.js";

  let { badge }: { badge: BadgeV1 | null } = $props();

  const passport = passportState();
  const tickets = $derived(passport.tickets);
  const count = $derived(tickets.upcoming.length + tickets.unknown.length + tickets.past.length);

  let checking = $state(false);
  let failed = $state(false);

  /**
   * Coaster credits, read once on open.
   *
   * A SEPARATE read from tickets, and a separate failure: they are different
   * rails (a credit is a statement on the rider's own feed, a ticket is a
   * server-verified linkage), so one being slow must not blank the other.
   *
   * `readMyCredits` never prompts — it reports `locked` when the keys are not
   * on this device rather than raising a ceremony at someone who did nothing
   * but open a tab. The credits rail is lazily imported so a rider who has
   * never tapped a coaster does not download it to look at their tickets.
   */
  type CreditRow = { subject: string; total: number; visibility: "public" | "private" };
  let credits = $state<CreditRow[] | null>(null);
  let creditsState = $state<"loading" | "ok" | "locked" | "unavailable">("loading");

  onMount(async () => {
    try {
      const { readMyCredits } = await import("../../credits/credits.js");
      const res = await readMyCredits();
      creditsState = res.status;
      credits = res.status === "ok" ? res.credits : null;
    } catch {
      creditsState = "unavailable";
    }
  });

  function coasterName(subject: string): string {
    const def = lookupSubject(WOCO_SUBJECTS, subject as `0x${string}`);
    const era = def ? currentEra(def) : null;
    return era?.name ?? "Coaster";
  }

  function coasterPark(subject: string): string | null {
    const def = lookupSubject(WOCO_SUBJECTS, subject as `0x${string}`);
    return def ? (currentEra(def)?.park ?? null) : null;
  }

  async function refresh() {
    checking = true;
    failed = (await gate.refresh()) === null;
    checking = false;
  }

  $effect(() => {
    if (auth.hasSession && !untrack(() => gate.status)) void refresh();
  });

  async function setUp() {
    if (await auth.ensureAccountSetup({ identity: false })) void refresh();
  }
</script>

{#snippet list(rows: typeof tickets.upcoming)}
  <ul class="list">
    {#each rows as ticket (`${ticket.seriesId}#${ticket.edition}`)}
      <li><PassportTicket {ticket} now={passport.now} pending={passport.loading} /></li>
    {/each}
  </ul>
{/snippet}

<div class="passport">
  <section>
    <h2 class="section-label">Tickets</h2>

    {#if !auth.hasSession}
      <p class="note">Your tickets show here once this device is set up for your account.</p>
      <button class="btn btn--ghost" onclick={setUp}>Show my tickets</button>
    {:else if !gate.status}
      {#if failed && !checking}
        <p class="note">Couldn't check your tickets right now. They aren't lost.</p>
        <button class="btn btn--text" onclick={refresh}>Try again</button>
      {:else}
        <p class="note">Checking your tickets…</p>
      {/if}
    {:else if count === 0}
      <p class="empty-title">No tickets yet</p>
      <p class="note">
        Bought one? Open the email with your ticket and tap <strong>Add to WoCo</strong>. A ticket
        you buy while signed in is added for you.
      </p>
      <button class="btn btn--primary" onclick={() => navigate("/discover")}>Find an event</button>
    {:else}
      {#if tickets.upcoming.length > 0}
        <h3 class="group">Upcoming</h3>
        {@render list(tickets.upcoming)}
      {/if}
      {#if tickets.unknown.length > 0}
        {@render list(tickets.unknown)}
      {/if}
      {#if tickets.past.length > 0}
        <h3 class="group">Past</h3>
        {@render list(tickets.past)}
      {/if}
      <p class="more">To add another ticket, tap <strong>Add to WoCo</strong> in its email.</p>
    {/if}
  </section>

  <section>
    <!-- VOCABULARY: a CREDIT is a coaster ridden once, ever; repeat rides are
         LAPS. Calling laps "credits" here would read as outsider copy to the
         exact audience this is for. -->
    <h2 class="section-label">Credits</h2>

    {#if creditsState === "loading"}
      <p class="note">Checking your logbook…</p>
    {:else if creditsState === "locked"}
      <!-- NOT "no credits": this device simply has no keys, and a returning
           rider on a new phone must not be told their collection is empty. -->
      <p class="note">Your coaster credits show here once this device is set up for your account.</p>
    {:else if creditsState === "unavailable"}
      <p class="note">Couldn't reach your logbook just now. Nothing is lost.</p>
    {:else if !credits || credits.length === 0}
      <p class="note">
        Ride a coaster and tap <strong>I rode it</strong> on its page. The credit and every lap time
        are kept here, private to you.
      </p>
    {:else}
      <ul class="list">
        {#each credits as credit (credit.subject)}
          <!-- The way BACK to the counter, and the reason this section earns
               its place beyond completeness: a rider who has closed the tab has
               no other route to the coaster page, which is reached by QR or a
               link and never from nav. -->
          <li>
            <button class="credit" onclick={() => navigate(`/coaster/${credit.subject}`)}>
              <span class="credit-id">
                <strong>{coasterName(credit.subject)}</strong>
                {#if coasterPark(credit.subject)}
                  <span class="credit-park">{coasterPark(credit.subject)}</span>
                {/if}
              </span>
              <span class="credit-tally">
                <span class="credit-num">{credit.total}</span>
                <span class="credit-unit">{credit.total === 1 ? "lap" : "laps"}</span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
      <p class="more">Tap a coaster to add a lap or see your times.</p>
    {/if}
  </section>

  <section>
    <h2 class="section-label">Stamps</h2>
    <!-- `value === true` only: a revoked badge is a later version of the same
         record, and `readBadge` returns it. -->
    {#if badge?.value === true}
      <div class="stamp">
        <CohortStamp epoch={badge.epoch} size={88} />
        <p class="stamp-text">
          <strong>{badge.epoch === 0 ? "Early adopter" : `Cohort ${badge.epoch}`}</strong>
          <span>Signed by WoCo and shown on your profile.</span>
        </p>
      </div>
    {:else}
      <p class="note">Stamps you earn collect here and show on your profile.</p>
    {/if}
  </section>
</div>

<style>
  .passport {
    display: flex;
    flex-direction: column;
    gap: 2.25rem;
    max-width: 36rem;
  }

  .note { margin: 0 0 0.875rem; font-size: 0.875rem; color: var(--text-secondary); max-width: 44ch; }
  .empty-title {
    margin: 0 0 0.25rem;
    font-family: var(--font-display);
    font-size: 1.25rem;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .note strong,
  .more strong { font-weight: 600; color: var(--text); }

  .group { margin: 0 0 0.5rem; font-size: 0.75rem; font-weight: 600; color: var(--text-muted); }
  .list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .list + .group { margin-top: 1.5rem; }
  .list + .list { margin-top: 0.5rem; }
  .more { margin: 1rem 0 0; font-size: 0.8125rem; color: var(--text-muted); }

  .credit {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    width: 100%;
    padding: 0.75rem 0.875rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    text-align: left;
    cursor: pointer;
    transition: border-color var(--transition-fast, 0.15s ease);
  }
  .credit:hover { border-color: var(--accent-subtle); }
  .credit-id { display: flex; flex-direction: column; gap: 0.125rem; min-width: 0; }
  .credit-id strong { font-size: 0.9375rem; font-weight: 600; color: var(--text); }
  .credit-park { font-size: 0.8125rem; color: var(--text-muted); }
  .credit-tally { display: flex; align-items: baseline; gap: 0.3125rem; flex-shrink: 0; }
  .credit-num {
    font-family: var(--font-display);
    font-size: 1.5rem;
    line-height: 1;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }
  .credit-unit {
    font-family: var(--font-mono);
    font-size: 0.625rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .stamp { display: flex; align-items: center; gap: 1rem; }
  .stamp-text { display: flex; flex-direction: column; gap: 0.125rem; margin: 0; }
  .stamp-text strong { font-size: 0.9375rem; font-weight: 600; }
  .stamp-text span { font-size: 0.8125rem; color: var(--text-muted); }
</style>
