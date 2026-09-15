<!--
  PassportTab — the owner's tickets and stamps, inside Profile.

  Tickets are private: Profile renders this tab only for the account's owner.
  They are the account's linked tickets, read from the unlock status, which
  needs a session already on this device; without one the tab offers a tap to
  set it up rather than opening on a signing prompt.
-->
<script lang="ts">
  import type { BadgeV1 } from "@woco/shared";
  import { untrack } from "svelte";
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

  async function linkTicket() {
    if (await gate.request()) void refresh();
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
        Bought one? Link it with the link in your confirmation email. A linked ticket also unlocks
        your name.
      </p>
      <div class="actions">
        <button class="btn btn--primary" onclick={linkTicket}>Link a ticket</button>
        <button class="btn btn--text" onclick={() => navigate("/discover")}>Find an event</button>
      </div>
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
      <button class="btn btn--text more" onclick={linkTicket}>Link another ticket</button>
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
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1.25rem; }

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
  .more { margin-top: 1rem; font-size: 0.8125rem; }

  .stamp { display: flex; align-items: center; gap: 1rem; }
  .stamp-text { display: flex; flex-direction: column; gap: 0.125rem; margin: 0; }
  .stamp-text strong { font-size: 0.9375rem; font-weight: 600; }
  .stamp-text span { font-size: 0.8125rem; color: var(--text-muted); }
</style>
