<!--
  MemberHome — a signed-in member's home: their invite first, because sharing
  it is what most people join for at launch; then their name; then the way into
  hosting.

  Every read here is prompt-free. The referral index is public on Swarm, and the
  two authenticated reads (unlock status, owned names) run only when a session
  is already on this device — a home screen must never open on a signing prompt.
  What each block says is decided in `member-state.ts`, where the suite pins it.
-->
<script lang="ts">
  import type { Hex0x } from "@woco/shared";
  import { untrack } from "svelte";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { navigate } from "../../router/router.svelte.js";
  import { gate } from "../gate/gate.svelte.js";
  import { inviteSheet } from "../../campaign/invite-sheet.svelte.js";
  import type { ReferrerIndexRead } from "../../campaign/records.js";
  import { markStudio } from "../../auth/studio-flag.js";
  import { profileLabel } from "../../sub-ens/roles.js";
  import { inviteStatusText, nameStateFrom, organisesFromUnlock } from "./member-state.js";

  let inviteRead = $state<ReferrerIndexRead | null>(null);
  let profileName = $state<string | null>(null);

  $effect(() => {
    const parent = auth.parent?.toLowerCase() as Hex0x | undefined;
    inviteRead = null;
    if (!parent) return;
    let current = true;
    import("../../campaign/records.js")
      .then((m) => m.readReferrerIndex(parent))
      .then((read) => { if (current) inviteRead = read; })
      .catch(() => { if (current) inviteRead = { status: "unavailable" }; });
    return () => { current = false; };
  });

  $effect(() => {
    const parent = auth.parent;
    profileName = null;
    if (!parent || !auth.hasSession) return;
    let current = true;
    if (!untrack(() => gate.status)) void gate.refresh();
    import("../../api/sub-ens.js")
      .then((m) => m.getOwnedSubEns())
      .then((resp) => { if (current) profileName = profileLabel(resp.data?.names ?? []); })
      .catch(() => { /* the name block falls back to the unlock status */ });
    return () => { current = false; };
  });

  // An organiser unlock proves the account organises even on a device that has
  // never opened the studio; remember it so the Studio link stays next visit.
  $effect(() => {
    if (organisesFromUnlock(gate.status?.via)) markStudio(auth.parent);
  });

  const inviteStatus = $derived(inviteStatusText(inviteRead));
  const nameState = $derived(nameStateFrom(profileName, gate.status));

  function startHosting() {
    markStudio(auth.parent);
    navigate("/creator");
  }
</script>

<div class="member-home">
  {#if !auth.parent}
    <section class="signed-out">
      <h1>Your invite and your name live here.</h1>
      <p class="lead">Sign in to share your invite and see who verified through it.</p>
      <button class="btn btn--primary" onclick={() => loginRequest.request({ context: "attendee" })}>
        Sign in
      </button>
    </section>
  {:else}
    <h1 class="sr-only">Home</h1>

    <section class="invite">
      <h2 class="invite-title">Know someone who runs events?</h2>
      <p class="lead">
        Invite them to host on WoCo. When they sell tickets, you earn a share of the platform fee.
      </p>
      <button class="btn btn--primary" onclick={() => inviteSheet.show()}>Show my code</button>
      {#if inviteStatus}
        <p class="status">{inviteStatus}</p>
      {/if}
    </section>

    {#if nameState !== "unknown"}
      <section class="block">
        <h2 class="section-label">Your name</h2>
        {#if nameState === "claimed"}
          <p class="name">{profileName}<span class="tld">.woco.eth</span></p>
          <p class="note">Your name on WoCo, and the one your invite link uses.</p>
        {:else if nameState === "unlocked"}
          <p class="note">
            Your account is unlocked. Claim a name and it becomes how people see you, and your
            invite link uses it.
          </p>
          <button
            class="btn btn--ghost"
            onclick={() => navigate(`/profile/${auth.parent?.toLowerCase()}`)}
          >Claim your name</button>
        {:else}
          <p class="name name--locked">
            <span class="blank" aria-hidden="true"></span><span class="tld">.woco.eth</span>
          </p>
          <p class="note">Your name, photo and bio unlock when you buy a ticket or put an event on sale.</p>
          <button class="btn btn--text" onclick={() => navigate("/discover")}>Find an event</button>
        {/if}
      </section>
    {/if}

    <div class="hosting">
      <div class="hosting-text">
        <strong>Run events?</strong>
        <span>Sell tickets from your own page.</span>
      </div>
      <button class="btn btn--ghost hosting-btn" onclick={startHosting}>Start hosting</button>
    </div>
  {/if}
</div>

<style>
  .member-home { max-width: 34rem; padding-block: 0.5rem 1rem; }

  .signed-out { padding-block: 2rem; }
  .signed-out h1 {
    margin: 0 0 0.625rem;
    font-size: clamp(1.75rem, 6vw, 2.25rem);
    line-height: 1.05;
    letter-spacing: -0.035em;
    text-wrap: balance;
  }

  .invite { margin-bottom: 2.25rem; }
  .invite-title {
    margin: 0 0 0.5rem;
    font-size: clamp(1.5rem, 5vw, 1.875rem);
    line-height: 1.1;
    letter-spacing: -0.03em;
    max-width: 16ch;
    text-wrap: balance;
  }
  .lead { margin: 0 0 1rem; font-size: 0.9375rem; color: var(--text-secondary); max-width: 36ch; }
  .status { margin: 0.875rem 0 0; font-size: 0.8125rem; color: var(--text-muted); max-width: 40ch; }

  .block { margin-bottom: 2rem; }
  .name {
    margin: 0 0 0.5rem;
    font-family: var(--font-display);
    font-size: 1.75rem;
    line-height: 1.1;
    font-weight: 700;
    letter-spacing: -0.03em;
    overflow-wrap: anywhere;
  }
  .name--locked { color: var(--text-dim); }
  .tld { color: var(--text-muted); font-weight: 500; }
  .blank {
    display: inline-block;
    width: 4.5ch;
    height: 0.9em;
    border-bottom: 2px solid var(--text-dim);
    vertical-align: -0.12em;
  }
  .note { margin: 0 0 0.875rem; font-size: 0.875rem; color: var(--text-secondary); max-width: 40ch; }

  .hosting {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding-block: 0.875rem;
    border-block: 1px solid var(--border);
  }
  .hosting-text { min-width: 0; }
  .hosting-text strong { display: block; font-size: 0.9375rem; font-weight: 600; }
  .hosting-text span { display: block; font-size: 0.8125rem; color: var(--text-muted); }
  .hosting-btn { flex: none; padding: 0.5rem 0.875rem; font-size: 0.8125rem; }
</style>
