<!--
  ContactsScreen — the people a member invited and the accounts they follow.
  It grows into contacts later; at launch it is these two lists.

  Invited follows #565's rules (see `campaign/invites.ts`): rows come from the
  issuer's referrer index plus one confirmation read each, four at a time; the
  count is the confirmations that read. Following is prompt-free: it uses only
  a seed already on this device. Names come from each profile, and a WoCo name
  is shown only after `verifyName` confirms it belongs to that account.
-->
<script lang="ts">
  import type { Hex0x, UserProfile } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { navigate } from "../../router/router.svelte.js";
  import { inviteSheet } from "../../campaign/invite-sheet.svelte.js";
  import { invitesFromReads, verifiedCount, type InviteRow } from "../../campaign/invites.js";
  import { settleInBatches } from "../../utils/settle-in-batches.js";
  import UserAvatar from "../../components/profile/UserAvatar.svelte";

  type Section<T> =
    | { status: "loading" }
    | { status: "unavailable" }
    | { status: "not-ready" }
    | { status: "ready"; value: T };

  let invited = $state<Section<InviteRow[]>>({ status: "loading" });
  let following = $state<Section<{ accounts: Hex0x[]; unreadable: number }>>({ status: "loading" });
  let profiles = $state<Record<string, UserProfile | null>>({});
  let verifiedLabels = $state<Record<string, string | null>>({});
  let attempt = $state(0);

  const invitedCount = $derived(invited.status === "ready" ? verifiedCount(invited.value) : 0);
  const followingCount = $derived(following.status === "ready" ? following.value.accounts.length : 0);

  async function loadProfile(address: Hex0x, signerHint: string | undefined, live: () => boolean) {
    const { getProfile } = await import("../../api/profiles.js");
    const profile = await getProfile(address, signerHint).catch(() => null);
    if (!live()) return;
    profiles = { ...profiles, [address]: profile };
    if (profile && !profile.displayName && profile.subEnsLabel) {
      const label = profile.subEnsLabel;
      // Same pattern as the profile and event pages: paint a verdict this device
      // already holds, then let the live check confirm or withdraw it.
      const { nameIsVerified, verifyName } = await import("../../sub-ens/verify-name.js");
      if (live() && nameIsVerified(label, address)) verifiedLabels = { ...verifiedLabels, [address]: label };
      const ok = await verifyName(label, address).catch(() => false);
      if (live()) verifiedLabels = { ...verifiedLabels, [address]: ok ? label : null };
    }
  }

  $effect(() => {
    const me = auth.parent?.toLowerCase() as Hex0x | undefined;
    void attempt;
    if (!me) return;
    let alive = true;
    const live = () => alive;
    invited = { status: "loading" };
    following = { status: "loading" };

    void (async () => {
      const records = await import("../../campaign/records.js");
      const index = await records.readReferrerIndex(me).catch(() => ({ status: "unavailable" as const }));
      if (!alive) return;
      if (index.status === "unavailable") {
        invited = { status: "unavailable" };
        return;
      }
      const referees = index.status === "found" ? index.referees : [];
      const reads = await settleInBatches(referees, 4, (referee) => records.readConfirmation(referee));
      if (!alive) return;
      const rows = invitesFromReads(me, referees, reads);
      invited = { status: "ready", value: rows };
      for (const row of rows) {
        // The confirmation's refereeFeed is the signer that owns their profile.
        void loadProfile(row.referee, row.confirmation?.refereeFeed, live);
      }
    })();

    void (async () => {
      const social = await import("../../social/social.js");
      const read = await social.readMyFollowsIfReady().catch(() => ({ status: "unavailable" as const }));
      if (!alive) return;
      if (read.status !== "found") {
        following = { status: read.status };
        return;
      }
      following = { status: "ready", value: { accounts: read.accounts, unreadable: read.unreadable } };
      for (const account of read.accounts) void loadProfile(account, undefined, live);
    })();

    return () => { alive = false; };
  });

  function nameFor(address: string): string {
    const profile = profiles[address];
    if (profile === undefined) return "";
    if (profile?.displayName) return profile.displayName;
    const label = verifiedLabels[address];
    return label ? `${label}.woco.eth` : "Name not set yet";
  }

  function shortDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }
</script>

<div class="contacts">
  {#if !auth.parent}
    <section class="signed-out">
      <h1>Contacts</h1>
      <p class="lead">Sign in to see the people you invited and the accounts you follow.</p>
      <button class="btn btn--primary" onclick={() => loginRequest.request({ context: "attendee" })}>
        Sign in
      </button>
    </section>
  {:else}
    <h1 class="title">Contacts</h1>
    <p class="lead">The people you've invited and the accounts you follow.</p>

    <section class="block" aria-labelledby="invited-title">
      <h2 class="section-label with-count"id="invited-title">
        Invited
        {#if invitedCount > 0}<span class="count">{invitedCount}</span>{/if}
      </h2>
      {#if invited.status === "loading"}
        <p class="quiet">Checking your invites…</p>
      {:else if invited.status === "unavailable"}
        <div class="empty">
          <p>Couldn't check your invites right now.</p>
          <button class="btn btn--ghost small" onclick={() => attempt++}>Try again</button>
        </div>
      {:else if invited.status === "ready" && invited.value.length === 0}
        <div class="empty">
          <p>
            People you invite show up here once they verify with Stripe. You earn a share of the
            platform fee when they sell tickets.
          </p>
          <button class="btn btn--primary small" onclick={() => inviteSheet.show()}>Show my code</button>
        </div>
      {:else if invited.status === "ready"}
        <ul class="rows">
          {#each invited.value as row (row.referee)}
            <li>
              <button class="row" onclick={() => navigate(`/profile/${row.referee}`)}>
                <UserAvatar address={row.referee} size={40} profile={profiles[row.referee] ?? null} />
                <span class="row-name">{nameFor(row.referee)}</span>
                {#if row.confirmation}
                  <span class="row-state row-state--ok">Verified {shortDate(row.confirmation.confirmedAt)}</span>
                {:else}
                  <span class="row-state">Couldn't check</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="block" aria-labelledby="following-title">
      <h2 class="section-label with-count"id="following-title">
        Following
        {#if followingCount > 0}<span class="count">{followingCount}</span>{/if}
      </h2>
      {#if following.status === "loading"}
        <p class="quiet">Checking who you follow…</p>
      {:else if following.status === "not-ready"}
        <div class="empty">
          <p>Who you follow shows up here after your next like or follow on this device.</p>
          <button class="btn btn--ghost small" onclick={() => navigate("/discover")}>Browse events</button>
        </div>
      {:else if following.status === "unavailable"}
        <div class="empty">
          <p>Couldn't check who you follow right now.</p>
          <button class="btn btn--ghost small" onclick={() => attempt++}>Try again</button>
        </div>
      {:else if following.status === "ready" && following.value.accounts.length === 0}
        <div class="empty">
          <p>Follow a venue or promoter from their page and they show up here.</p>
          <button class="btn btn--ghost small" onclick={() => navigate("/discover")}>Browse events</button>
        </div>
      {:else if following.status === "ready"}
        <ul class="rows">
          {#each following.value.accounts as account (account)}
            <li>
              <button class="row" onclick={() => navigate(`/profile/${account}`)}>
                <UserAvatar address={account} size={40} profile={profiles[account] ?? null} />
                <span class="row-name">{nameFor(account)}</span>
              </button>
            </li>
          {/each}
        </ul>
        {#if following.value.unreadable > 0}
          <p class="quiet">
            {following.value.unreadable === 1
              ? "One more couldn't be checked right now."
              : `${following.value.unreadable} more couldn't be checked right now.`}
          </p>
        {/if}
      {/if}
    </section>
  {/if}
</div>

<style>
  .contacts { max-width: 34rem; padding-block: 0.5rem 1rem; }

  .signed-out { padding-block: 2rem; }
  .signed-out h1,
  .title {
    margin: 0 0 0.5rem;
    font-size: clamp(1.75rem, 6vw, 2.25rem);
    line-height: 1.05;
    letter-spacing: -0.035em;
  }
  .lead { margin: 0 0 1.75rem; font-size: 0.9375rem; color: var(--text-secondary); max-width: 36ch; }

  .block { margin-bottom: 2rem; }
  .with-count { display: flex; align-items: baseline; gap: 0.5rem; }
  .count { font-weight: 500; color: var(--text-muted); font-variant-numeric: tabular-nums; }

  .quiet { margin: 0.625rem 0 0; font-size: 0.8125rem; color: var(--text-muted); }

  .empty { padding-top: 0.875rem; border-top: 1px solid var(--border); }
  .empty p { margin: 0 0 0.75rem; font-size: 0.875rem; color: var(--text-secondary); max-width: 38ch; }
  .small { padding: 0.5rem 0.875rem; font-size: 0.8125rem; }

  .rows { list-style: none; margin: 0; padding: 0; border-bottom: 1px solid var(--border); }
  .row {
    display: grid;
    grid-template-columns: 2.5rem minmax(0, 1fr) auto;
    align-items: center;
    column-gap: 0.75rem;
    width: 100%;
    padding-block: 0.75rem;
    border-top: 1px solid var(--border);
    text-align: left;
    transition: background var(--transition);
  }
  .row:hover .row-name { text-decoration: underline; text-decoration-color: var(--text-dim); text-underline-offset: 3px; }
  .row-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
  }
  .row-state { font-size: 0.78125rem; font-weight: 600; color: var(--text-muted); white-space: nowrap; }
  .row-state--ok { color: var(--accent-text); }
</style>
