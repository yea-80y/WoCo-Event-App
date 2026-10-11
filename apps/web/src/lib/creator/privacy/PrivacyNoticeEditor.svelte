<!--
  The organiser's privacy notice: review, fill the gaps, confirm and publish.

  The organiser is the controller for their attendees' details and WoCo is their
  processor (docs/legal/ORGANISER_TERMS.md §4), so the notice attendees see at
  checkout is the organiser's. It is pre-filled from what WoCo already knows -
  Stripe business details, the profile name - and every fact WoCo can vouch for
  is generated from docs/legal. What only the organiser can say stays a marked gap
  until they fill it. Until they confirm, attendees see the pre-filled notice.

  Publishing writes the organiser's own public feed: earlier versions stay
  retrievable from the network, so the screen says so before the button.
-->
<script lang="ts">
  import { untrack } from "svelte";
  import {
    buildOrganiserNotice,
    cleanNoticeText,
    noticeTodos,
    noticeDate,
    ORGANISER_NOTICE_LIMITS,
    type OrganiserNoticeField,
    type OrganiserNoticeV1,
  } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { getStripeAccountStatus } from "../../api/stripe.js";
  import { getProfile } from "../../api/profiles.js";
  import { isTicketRequired } from "../../api/attendee-gate.js";
  import OrganiserNoticeView from "../../legal/OrganiserNoticeView.svelte";
  import { publishOwnNotice, readOwnNotice, stripEmpty, WOCO_POLICY_URL } from "../../legal/organiser-notice.js";

  type Draft = Record<OrganiserNoticeField, string> & { marketingSoftOptIn: boolean };

  let draft = $state<Draft>({
    organiserName: "",
    contactEmail: "",
    postalAddress: "",
    icoRegistration: "",
    orderFormPurpose: "",
    sharing: "",
    retention: "",
    automatedDecisions: "",
    marketingSoftOptIn: false,
  });
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let saved = $state<OrganiserNoticeV1 | null>(null);
  let prefilledFrom = $state<string[]>([]);
  let checked = $state(false);
  let publishing = $state(false);
  let publishError = $state<string | null>(null);
  let justPublished = $state(false);

  /** Per-field problems, so the form says which box is wrong rather than refusing silently. */
  const fieldErrors = $derived.by(() => {
    const out: Partial<Record<OrganiserNoticeField, string>> = {};
    for (const f of Object.keys(ORGANISER_NOTICE_LIMITS) as OrganiserNoticeField[]) {
      if (cleanNoticeText(f, draft[f]) === null) {
        out[f] = f === "contactEmail" ? "That doesn't look like an email address." : `Keep this under ${ORGANISER_NOTICE_LIMITS[f]} characters, on one line where it's a single field.`;
      }
    }
    if (!draft.organiserName.trim()) out.organiserName = "Your name or business name is needed.";
    return out;
  });
  const valid = $derived(Object.keys(fieldErrors).length === 0);

  /** The draft as the notice attendees would see once confirmed. */
  const previewDoc = $derived.by(() => {
    const cleaned = stripEmpty({ ...draft }) as Partial<OrganiserNoticeV1>;
    return buildOrganiserNotice({
      notice: draft.organiserName.trim() && valid
        ? ({ ...cleaned, format: "woco.privacy-notice.v1", address: auth.parent?.toLowerCase() ?? "", confirmedAt: new Date().toISOString() } as OrganiserNoticeV1)
        : null,
      fallback: { name: draft.organiserName },
      wocoPolicyUrl: WOCO_POLICY_URL,
    });
  });
  const todos = $derived(noticeTodos(previewDoc));

  // Re-load whenever the signed-in account changes (sign-in from this screen
  // included): the form must always start from THIS account's stored notice, or a
  // publish would overwrite a confirmed notice with a blank or pre-filled one.
  let loadedFor = $state<string | null>(null);
  $effect(() => {
    const parent = auth.parent?.toLowerCase() ?? null;
    if (parent === untrack(() => loadedFor)) return;
    loadedFor = parent;
    untrack(() => void load());
  });

  async function load() {
    loading = true;
    loadError = null;
    saved = null;
    prefilledFrom = [];
    for (const f of Object.keys(ORGANISER_NOTICE_LIMITS) as OrganiserNoticeField[]) draft[f] = "";
    draft.marketingSoftOptIn = false;
    checked = false;
    const parent = auth.parent?.toLowerCase();
    if (!parent) {
      loading = false;
      return;
    }
    try {
      const signerAddress = await auth.getContentFeedSignerAddress();
      // No confirmed signer is "can't tell", never "nothing saved": treating it as
      // absent would offer a fresh form over a notice that exists.
      if (!signerAddress) {
        loadError = "Couldn't confirm your account keys on this device yet. Try again in a moment.";
        return;
      }
      const own = await readOwnNotice(parent, signerAddress);
      if (own.status === "unavailable") {
        loadError = own.error;
        return;
      }
      if (own.status === "found") {
        saved = own.notice;
        for (const f of Object.keys(ORGANISER_NOTICE_LIMITS) as OrganiserNoticeField[]) draft[f] = own.notice[f] ?? "";
        draft.marketingSoftOptIn = own.notice.marketingSoftOptIn === true;
        return;
      }
      // Nothing confirmed yet: pre-fill from what WoCo already has.
      const [stripe, profile] = await Promise.all([
        getStripeAccountStatus().catch(() => null),
        getProfile(parent).catch(() => null),
      ]);
      const bp = stripe?.businessProfile;
      const from: string[] = [];
      if (bp?.name) { draft.organiserName = bp.name; from.push("Stripe"); }
      else if (profile?.displayName) { draft.organiserName = profile.displayName; from.push("your profile"); }
      if (bp?.supportEmail) { draft.contactEmail = bp.supportEmail; if (!from.includes("Stripe")) from.push("Stripe"); }
      if (bp?.supportAddress) draft.postalAddress = bp.supportAddress;
      prefilledFrom = from;
    } catch (e) {
      loadError = e instanceof Error ? e.message : "Couldn't load your notice.";
    } finally {
      loading = false;
    }
  }

  async function publish() {
    publishError = null;
    justPublished = false;
    const parent = auth.parent?.toLowerCase();
    if (!parent || !valid || !checked) return;
    publishing = true;
    try {
      const signer = await auth.getContentFeedSigner();
      if (!signer) throw new Error("This account can't publish content yet. Sign in with your passkey and try again.");
      const { organiserName, marketingSoftOptIn, ...rest } = draft;
      // The account may have changed while this was open: never publish a form
      // loaded for someone else.
      if (loadedFor !== parent || loading || loadError) throw new Error("Your account changed - reload this page and check the form again.");
      saved = await publishOwnNotice(parent, signer, { organiserName, marketingSoftOptIn, ...rest });
      justPublished = true;
      checked = false;
    } catch (e) {
      publishError = isTicketRequired(e)
        ? "Publishing needs your account unlocked first - connect Stripe or publish an event, then come back."
        : e instanceof Error ? e.message : "Couldn't publish your notice. Nothing was changed.";
    } finally {
      publishing = false;
    }
  }

  const LABELS: Record<OrganiserNoticeField, { label: string; hint: string; multiline?: boolean }> = {
    organiserName: { label: "Your name or business name", hint: "Who attendees are dealing with - the name on their card statement is a good choice." },
    contactEmail: { label: "Privacy contact email", hint: "Where attendees write about their details. A business address you read." },
    postalAddress: { label: "Postal address (optional)", hint: "A business address. Leave it empty rather than giving a home address.", multiline: true },
    icoRegistration: { label: "ICO registration number (optional)", hint: "Only if you have one. Many small organisers are exempt - the ICO's fee checker tells you." },
    orderFormPurpose: { label: "Why you ask your order-form questions", hint: "One or two sentences, for example \"To seat you and plan catering.\" Take extra care with anything about health, such as dietary or access needs.", multiline: true },
    sharing: { label: "Who else you share attendee details with", hint: "For example the venue, door staff or a co-promoter - or \"No one else.\"", multiline: true },
    retention: { label: "How long you keep attendee details", hint: "Include guest lists you download or put on a door scanner. For example \"Until 3 months after the event.\"", multiline: true },
    automatedDecisions: { label: "Automated decisions", hint: "Whether you make decisions about attendees purely by computer that significantly affect them. Most organisers write \"We don't.\"", multiline: true },
  };
  const FIELDS = Object.keys(LABELS) as OrganiserNoticeField[];
</script>

<div class="editor">
  <header class="editor-head">
    <h1>Your privacy notice</h1>
    <p class="lede">
      You're responsible for your attendees' details - you're the controller, and WoCo handles them for you as
      your processor. This notice tells attendees what that means, and it's linked from every checkout, event page
      and site you run on WoCo.
    </p>
    <p class="lede">
      We've pre-filled everything WoCo can vouch for about how its platform works. Check it, fill the gaps marked
      below, and publish. It's a starting point written from our own policies - it isn't legal advice, so if your
      situation is unusual, have someone qualified look at it.
    </p>
  </header>

  {#if !auth.isConnected}
    <p>Sign in to set up your notice.</p>
    <button class="primary" onclick={() => loginRequest.request()}>Sign in</button>
  {:else if loading}
    <p class="muted">Loading your notice…</p>
  {:else if loadError}
    <p class="error" role="alert">{loadError}</p>
    <button class="secondary" onclick={load}>Try again</button>
  {:else}
    <p class="status" class:status--ok={saved}>
      {#if saved}
        Confirmed on {noticeDate(saved.confirmedAt)}. Attendees see this notice. Edit and publish again to change it.
      {:else}
        Not confirmed yet - attendees currently see the pre-filled version.
        {#if prefilledFrom.length}We've filled in what we could from {prefilledFrom.join(" and ")}.{/if}
      {/if}
    </p>

    <div class="layout">
      <form class="fields" onsubmit={(e) => { e.preventDefault(); void publish(); }}>
        {#each FIELDS as f}
          <label class="field">
            <span class="field-label">{LABELS[f].label}</span>
            {#if LABELS[f].multiline}
              <textarea rows="3" bind:value={draft[f]} maxlength={ORGANISER_NOTICE_LIMITS[f]} aria-invalid={!!fieldErrors[f]}></textarea>
            {:else}
              <input type={f === "contactEmail" ? "email" : "text"} bind:value={draft[f]} maxlength={ORGANISER_NOTICE_LIMITS[f]} aria-invalid={!!fieldErrors[f]} />
            {/if}
            <span class="field-hint">{LABELS[f].hint}</span>
            {#if fieldErrors[f]}<span class="field-error">{fieldErrors[f]}</span>{/if}
          </label>
        {/each}

        <label class="check">
          <input type="checkbox" bind:checked={draft.marketingSoftOptIn} />
          <span>
            I also email past buyers about similar events without a tick at checkout, relying on the "soft opt-in".
            Leave this off if you only email people who ticked the box.
          </span>
        </label>

        <div class="publish">
          {#if todos.length}
            <p class="muted">{todos.length} {todos.length === 1 ? "gap" : "gaps"} left - the preview marks {todos.length === 1 ? "it" : "them"}. You can publish now and fill {todos.length === 1 ? "it" : "them"} later.</p>
          {/if}
          <p class="warn">
            Your notice is public. Each time you publish, the earlier version stays retrievable from the network, so
            use business contact details, not personal ones.
          </p>
          <label class="check">
            <input type="checkbox" bind:checked={checked} />
            <span>I've read this notice and it describes how I handle my attendees' details.</span>
          </label>
          {#if publishError}<p class="error" role="alert">{publishError}</p>{/if}
          {#if justPublished}<p class="ok" role="status">Published. Attendees now see your confirmed notice.</p>{/if}
          <button class="primary" type="submit" disabled={!valid || !checked || publishing}>
            {publishing ? "Publishing…" : saved ? "Confirm and publish changes" : "Confirm and publish"}
          </button>
        </div>
      </form>

      <section class="preview" aria-label="Preview">
        <h2 class="preview-head">Preview</h2>
        <OrganiserNoticeView doc={previewDoc} mode="editor" />
      </section>
    </div>
  {/if}
</div>

<style>
  .editor { max-width: 1100px; margin: 0 auto; padding: 1.5rem 1.25rem 3rem; }
  .editor-head h1 { font-size: 1.5rem; margin: 0 0 0.75rem; }
  .lede { color: var(--text-secondary); max-width: 760px; margin: 0 0 0.75rem; line-height: 1.55; }
  .status { padding: 0.625rem 0.875rem; border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--text-secondary); margin: 1rem 0; }
  .status--ok { border-color: var(--success); }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 2rem; align-items: start; }
  @media (max-width: 860px) { .layout { grid-template-columns: 1fr; } }
  .fields { display: flex; flex-direction: column; gap: 1rem; }
  .field { display: flex; flex-direction: column; gap: 0.25rem; }
  .field-label { font-weight: 600; font-size: 0.875rem; }
  .field-hint { font-size: 0.8125rem; color: var(--text-muted); }
  .field-error, .error { font-size: 0.8125rem; color: var(--error); }
  .field input, .field textarea { font: inherit; padding: 0.5rem 0.625rem; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-input); color: var(--text); }
  .check { display: flex; gap: 0.5rem; align-items: flex-start; font-size: 0.875rem; }
  .publish { display: flex; flex-direction: column; gap: 0.625rem; padding-top: 0.5rem; border-top: 1px solid var(--border); }
  .warn { font-size: 0.8125rem; color: var(--text-secondary); }
  .ok { font-size: 0.875rem; color: var(--success); }
  .muted { color: var(--text-muted); font-size: 0.875rem; }
  .preview { border: 1px solid var(--border); border-radius: var(--radius-md); padding: 1rem 1.25rem; background: var(--bg-surface); }
  .preview-head { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin: 0 0 0.75rem; }
  .primary { align-self: flex-start; padding: 0.625rem 1rem; border-radius: var(--radius-md); background: var(--accent); color: var(--accent-ink); font-weight: 600; border: 0; cursor: pointer; }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .secondary { padding: 0.5rem 0.875rem; border-radius: var(--radius-md); border: 1px solid var(--border); background: none; color: var(--text); cursor: pointer; }
</style>
