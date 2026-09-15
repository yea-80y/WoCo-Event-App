<!--
  InviteLanding — the screen an invite link (`#/ref/{name or address}`) opens.

  An invite is for someone who runs events, so it does not open Discover (a
  ticket buyer's page) and it does not open a sign-up popup: a visitor who
  meets a login box before they know what WoCo is closes the tab. The router
  has already stored the invite by the time this renders, so browsing away
  keeps it.

  The inviter is named only once a lookup confirms the name exists, so a link
  carrying a mistyped or unregistered name never credits someone who isn't
  there. Only a WoCo name is shown — never an account address (owner decision,
  2026-09-14).
-->
<script lang="ts">
  import { auth } from "../auth/auth-store.svelte.js";
  import { loginRequest } from "../auth/login-request.svelte.js";
  import { navigate } from "../router/router.svelte.js";
  import { classifyRefToken } from "../campaign/referral-capture.js";
  import { markStudio } from "../auth/studio-flag.js";
  import WocoWordmark from "../components/brand/WocoWordmark.svelte";
  import CohortStamp from "../components/campaign/CohortStamp.svelte";

  interface Props {
    token?: string;
  }
  let { token = "" }: Props = $props();

  const link = $derived(classifyRefToken(token));
  const invited = $derived(link.kind !== "invalid");
  // A second lookup of the name the router is also resolving: one cheap request,
  // and this page never depends on which of the two finishes first. A lookup
  // nobody answered shows no name rather than an unconfirmed one.
  let inviterName = $state<string | null>(null);
  $effect(() => {
    const current = link;
    inviterName = null;
    if (current.kind !== "name") return;
    let live = true;
    import("../api/sub-ens.js")
      .then((m) => m.resolveSubEnsAddress(current.label))
      .then((res) => {
        if (live && res.status === "found") inviterName = `${current.label}.woco.eth`;
      })
      .catch(() => { /* no name shown */ });
    return () => { live = false; };
  });

  const signedIn = $derived(auth.ready && auth.isConnected && !!auth.parent);

  async function startHosting() {
    if (!signedIn) {
      const ok = await loginRequest.request({ context: "invite" });
      if (!ok) return;
    }
    markStudio(auth.parent);
    navigate("/creator");
  }

  // Claims the live landing page already makes, trimmed to fit a phone.
  const reasons = [
    {
      title: "Your name on it, not ours.",
      body: "Your artwork, your colours, your name at the top. No WoCo logo in the corner.",
    },
    {
      title: "Charge a booking fee. Keep it.",
      body: "Every platform adds one and pockets it. Here, the booking fee is yours.",
    },
    {
      title: "The door works without internet.",
      body: "The scanner checks each ticket on the phone itself, so a cellar bar scans as fast as anywhere.",
    },
  ];
</script>

<div class="invite-page">
  <header class="top">
    <button class="brand" onclick={() => navigate("/")} aria-label="WoCo home">
      <WocoWordmark height={20} variant="default" showTagline={false} />
    </button>
    {#if auth.ready && !signedIn}
      <button class="btn btn--text" onclick={() => loginRequest.request()}>Sign in</button>
    {/if}
  </header>

  <main class="body">
    {#if invited}
      <section class="card-invite" aria-label="Your invitation">
        <div class="card-top">
          <p class="card-label">Invitation</p>
          {#if inviterName}
            <p class="card-from">from {inviterName}</p>
          {/if}
        </div>
        <p class="card-name">You've been invited</p>
        <p class="card-line">to host your events on WoCo.</p>
        <div class="card-foot">
          <span class="card-stamp"><CohortStamp epoch={0} size={44} /></span>
          <p>Verify with Stripe and you both get the early adopter stamp.</p>
        </div>
      </section>
    {/if}

    <section class="hero">
      <h1>Sell tickets from your own page.</h1>
      <p class="sub">And build a following that stays yours, even if you leave.</p>
      <button class="btn btn--primary btn--lg cta" onclick={startHosting}>
        {signedIn ? "Go to your studio" : "Start hosting"}
      </button>
      <p class="alt">
        Just looking for events?
        <button class="btn btn--text" onclick={() => navigate("/discover")}>Browse events</button>
      </p>
    </section>

    <section class="block">
      <h2 class="section-label">How it works</h2>
      <ol class="steps">
        <li>Create your account with email, a passkey or a wallet.</li>
        <li>Verify with Stripe so you can get paid.</li>
        <li>Put your first event on sale.</li>
      </ol>
    </section>

    <section class="block">
      <h2 class="section-label">Why hosts use it</h2>
      {#each reasons as reason (reason.title)}
        <div class="reason">
          <strong>{reason.title}</strong>
          <span>{reason.body}</span>
        </div>
      {/each}
    </section>

    {#if invited}
      <p class="fine">
        {inviterName ?? "Whoever invited you"} earns a share of WoCo's fee on your ticket
        sales. It doesn't change what you pay.
      </p>
    {/if}
  </main>

  <footer class="foot">
    <button class="btn btn--text" onclick={() => navigate("/legal/terms")}>Terms</button>
    <button class="btn btn--text" onclick={() => navigate("/legal/privacy")}>Privacy</button>
  </footer>
</div>

<style>
  .invite-page {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    max-width: 34rem;
    margin: 0 auto;
    padding-inline: 1.25rem;
    padding-block: 0 2.5rem;
  }

  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-block: 0.875rem;
    margin-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
  }
  .brand { display: flex; align-items: center; }

  /* The invitation is printed like a stub: bone paper, a torn line, the stamp
     both people receive once the invite is confirmed. */
  .card-invite {
    margin-bottom: 2rem;
    padding: 1.125rem 1.125rem 1rem;
    background: var(--text);
    color: var(--accent-ink);
    border-radius: var(--radius-md);
  }
  /* The top row holds its height before the name arrives, so confirming the
     inviter never shifts the card. */
  .card-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    min-height: 1.25rem;
    margin-bottom: 0.625rem;
  }
  .card-label { margin: 0; font-size: 0.75rem; font-weight: 600; opacity: 0.7; }
  .card-from {
    margin: 0;
    min-width: 0;
    font-size: 0.8125rem;
    font-weight: 700;
    text-align: right;
    overflow-wrap: anywhere;
  }
  .card-name {
    margin: 0;
    font-family: var(--font-display);
    font-size: 1.625rem;
    line-height: 1.08;
    font-weight: 700;
    letter-spacing: -0.03em;
    overflow-wrap: anywhere;
  }
  .card-line { margin: 0.125rem 0 0; font-size: 0.9375rem; line-height: 1.35; }
  .card-foot {
    position: relative;
    display: grid;
    grid-template-columns: 2.75rem minmax(0, 1fr);
    gap: 0.75rem;
    align-items: center;
    margin-top: 1rem;
    padding-top: 0.875rem;
    border-top: 1.5px dashed color-mix(in srgb, var(--accent-ink) 30%, transparent);
  }
  .card-foot::before,
  .card-foot::after {
    content: "";
    position: absolute;
    top: -0.5625rem;
    width: 1rem;
    height: 1rem;
    border-radius: 50%;
    background: var(--bg);
  }
  .card-foot::before { left: -1.625rem; }
  .card-foot::after { right: -1.625rem; }
  .card-foot p { margin: 0; font-size: 0.8125rem; line-height: 1.35; font-weight: 500; opacity: 0.75; }
  .card-stamp { display: block; line-height: 0; }
  .card-invite .card-stamp :global(.stamp) { color: var(--accent-ink); }

  .hero { margin-bottom: 2.25rem; }
  .hero h1 {
    margin: 0 0 0.625rem;
    font-size: clamp(2rem, 7vw, 2.75rem);
    line-height: 1.02;
    letter-spacing: -0.04em;
    text-wrap: balance;
  }
  .sub { margin: 0 0 1.25rem; font-size: 0.9375rem; color: var(--text-secondary); max-width: 32ch; }
  .cta { width: 100%; }
  .alt { margin: 0.875rem 0 0; font-size: 0.875rem; color: var(--text-muted); }

  .block { margin-bottom: 2rem; }

  .steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; counter-reset: step; }
  .steps li {
    counter-increment: step;
    display: grid;
    grid-template-columns: 1.25rem minmax(0, 1fr);
    gap: 0.5rem;
    font-size: 0.875rem;
    color: var(--text-secondary);
  }
  .steps li::before {
    content: counter(step);
    padding-top: 0.0625rem;
    font-family: var(--font-mono);
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--accent-text);
  }

  .reason { padding-block: 0.875rem; border-top: 1px solid var(--border); }
  .reason:last-child { border-bottom: 1px solid var(--border); }
  .reason strong { display: block; margin-bottom: 0.125rem; font-size: 0.96875rem; font-weight: 600; line-height: 1.3; }
  .reason span { display: block; font-size: 0.84375rem; color: var(--text-secondary); }

  .fine { margin: 0; font-size: 0.78125rem; color: var(--text-muted); max-width: 40ch; }

  .foot { display: flex; gap: 1.25rem; margin-top: auto; padding-top: 2rem; }
  .foot .btn--text { font-size: 0.8125rem; color: var(--text-muted); }
</style>
