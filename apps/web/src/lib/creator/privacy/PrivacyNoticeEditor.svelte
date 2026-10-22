<!--
  The organiser's privacy notice: check the choices, publish.

  The organiser is the controller for their attendees' details and WoCo is their
  processor (docs/legal/ORGANISER_TERMS.md §4), so the notice attendees see at
  checkout is the organiser's. Everything WoCo can vouch for is generated from
  docs/legal; what only the organiser decides is a pick-list with the answer
  nearly everyone gives already chosen, plus an "anything else" box that ends one
  of our sentences. The defaults are theirs to change - a choice WoCo locked would
  be WoCo deciding the purposes. Nothing they sell goes on sale until they publish
  (the server refuses every hold and checkout - apps/server/src/lib/legal/notice-gate.ts),
  and the public notice page says it isn't published rather than show this draft.

  The notice is public. Organiser Terms §4 says earlier versions stay retrievable;
  this screen only asks for business, not personal, details - the advice every
  website's privacy page needs, without singling out the network.
-->
<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import {
    buildOrganiserNotice,
    cleanNoticeText,
    noticeTodos,
    noticeDate,
    noticeMarketingMode,
    NOTICE_DEFAULTS,
    NOTICE_SHARING,
    NOTICE_SHARING_TEXT,
    ORGANISER_NOTICE_FORMAT,
    ORGANISER_NOTICE_LIMITS,
    ORDER_RETENTION_MONTHS,
    type MarketingMode,
    type NoticeSharing,
    type OrganiserNoticeField,
    type OrganiserNotice,
  } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { getStripeAccountStatus } from "../../api/stripe.js";
  import { getProfile } from "../../api/profiles.js";
  import { isTicketRequired } from "../../api/attendee-gate.js";
  import OrganiserNoticeView from "../../legal/OrganiserNoticeView.svelte";
  import { publishOwnNotice, readOwnNoticeWithLateRetry, stripEmpty, WOCO_POLICY_URL } from "../../legal/organiser-notice.js";
  import { LateRetryCancelled, retryOnceIfInconclusive } from "../../swarm/late-retry.js";
  import type { ContentFeedWriteBase } from "../../swarm/content-feed.js";

  type Draft = Record<OrganiserNoticeField, string> & {
    sharing: NoticeSharing[];
    marketingBasis: MarketingMode;
  };

  const TEXT_FIELDS = Object.keys(ORGANISER_NOTICE_LIMITS) as OrganiserNoticeField[];

  function freshDraft(): Draft {
    return {
      organiserName: "",
      contactEmail: "",
      postalAddress: "",
      icoRegistration: "",
      extraSharing: "",
      extraOrderFormUse: "",
      sharing: [...NOTICE_DEFAULTS.sharing],
      // A new draft only: a published notice loads its own answer below.
      marketingBasis: NOTICE_DEFAULTS.marketing,
    };
  }

  let draft = $state<Draft>(freshDraft());
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let saved = $state<OrganiserNotice | null>(null);
  let prefilledFrom = $state<string[]>([]);
  let checked = $state(false);
  let publishing = $state(false);
  let publishError = $state<string | null>(null);
  let justPublished = $state(false);
  let publishedUnconfirmed = $state(false);
  /** Which read is waiting out bee's one-minute skip list before its one retry (#943). */
  let waiting = $state<"load" | "publish" | null>(null);
  /**
   * The read this screen's next publish writes after (#943) - never shown, so not
   * reactive. Set by the load and by each publish this screen confirms.
   */
  let writeBase: ContentFeedWriteBase<unknown> | null = null;
  /** When `writeBase` was read. Older than this, a publish reads afresh: by then
   *  bee's one-minute skip list has lapsed, so that read is clean (Fable, #945 N1). */
  let writeBaseAt = 0;
  const WRITE_BASE_MAX_AGE_MS = 5 * 60_000;
  /**
   * Cancels a waiting retry when the account changes or the screen closes: a
   * notice must not be published a minute later where nobody sees it happen, and
   * leaving simply leaves it unpublished. A write already in flight completes.
   */
  let lifetime: AbortController | null = null;
  onDestroy(() => lifetime?.abort());

  /** Per-field problems, so the form says which box is wrong rather than refusing silently. */
  const fieldErrors = $derived.by(() => {
    const out: Partial<Record<OrganiserNoticeField, string>> = {};
    for (const f of TEXT_FIELDS) {
      if (cleanNoticeText(f, draft[f]) === null) {
        out[f] = f === "contactEmail" ? "That doesn't look like an email address." : `Keep this under ${ORGANISER_NOTICE_LIMITS[f]} characters, on one line.`;
      }
    }
    if (!draft.organiserName.trim()) out.organiserName = "Your name or business name is needed.";
    return out;
  });
  const valid = $derived(Object.keys(fieldErrors).length === 0);

  /** What gets stored: the text fields, emptied ones absent, plus the choices. */
  function payload(): Omit<OrganiserNotice, "format" | "address" | "confirmedAt"> {
    const text: Record<string, string> = {};
    for (const f of TEXT_FIELDS) text[f] = draft[f];
    return {
      ...(stripEmpty(text) as Pick<OrganiserNotice, "organiserName">),
      sharing: NOTICE_SHARING.filter((c) => draft.sharing.includes(c)),
      orderRetentionMonths: ORDER_RETENTION_MONTHS,
      ...(draft.marketingBasis === "own-events" ? { marketingBasis: "own-events" as const } : {}),
    };
  }

  /** The draft as the notice attendees would see once published. */
  const previewDoc = $derived.by(() =>
    buildOrganiserNotice({
      notice: draft.organiserName.trim() && valid
        ? { ...payload(), format: ORGANISER_NOTICE_FORMAT, address: auth.parent?.toLowerCase() ?? "", confirmedAt: new Date().toISOString() }
        : null,
      fallback: { name: draft.organiserName },
      wocoPolicyUrl: WOCO_POLICY_URL,
    }),
  );
  const todos = $derived(noticeTodos(previewDoc));

  // Re-load whenever the signed-in account changes (sign-in from this screen
  // included): the form must always start from THIS account's stored notice, or a
  // publish would overwrite a published notice with a blank or pre-filled one.
  let loadedFor = $state<string | null>(null);
  $effect(() => {
    const parent = auth.parent?.toLowerCase() ?? null;
    if (parent === untrack(() => loadedFor)) return;
    loadedFor = parent;
    untrack(() => void load());
  });

  async function load() {
    lifetime?.abort();
    const life = new AbortController();
    lifetime = life;
    loading = true;
    loadError = null;
    saved = null;
    prefilledFrom = [];
    draft = freshDraft();
    checked = false;
    writeBase = null;
    waiting = null;
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
      // Asked once more after a minute when nobody could answer (#943): a new
      // organiser's first notice has never been written, and their own screens
      // have just asked about it often enough for bee to stop answering.
      const own = await readOwnNoticeWithLateRetry(parent, signerAddress, {
        signal: life.signal,
        onWait: () => { waiting = "load"; },
      });
      if (life !== lifetime) return;
      waiting = null;
      if (own.status === "unavailable") {
        loadError = own.error;
        return;
      }
      writeBase = own.base;
      writeBaseAt = Date.now();
      if (own.status === "found") {
        const n = own.notice;
        saved = n;
        for (const f of TEXT_FIELDS) draft[f] = n[f] ?? "";
        draft.sharing = [...n.sharing];
        draft.marketingBasis = noticeMarketingMode(n);
        return;
      }
      // Nothing published yet: pre-fill from what WoCo already has.
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
      if (e instanceof LateRetryCancelled || life !== lifetime) return;
      loadError = e instanceof Error ? e.message : "Couldn't load your notice.";
    } finally {
      // A newer load owns the screen now.
      if (life === lifetime) {
        loading = false;
        waiting = null;
      }
    }
  }

  async function publish() {
    publishError = null;
    justPublished = false;
    const parent = auth.parent?.toLowerCase();
    if (!parent || !valid || !checked) return;
    publishing = true;
    // What the organiser confirmed, as they pressed Publish - a late retry
    // publishes this, never edits made while it waited.
    const confirmed = payload();
    let base = writeBase && Date.now() - writeBaseAt < WRITE_BASE_MAX_AGE_MS ? writeBase : null;
    const life = lifetime;
    try {
      const signer = await auth.getContentFeedSigner();
      if (!signer) throw new Error("This account can't publish content yet. Sign in with your passkey and try again.");
      // Once more after a minute when the read under the write could not say (#943).
      const out = await retryOnceIfInconclusive(async () => {
        // The account may have changed while this was open, or while it waited:
        // never publish a form loaded for someone else.
        if (auth.parent?.toLowerCase() !== parent || loadedFor !== parent || loading || loadError) {
          throw new Error("Your account changed - reload this page and check the form again.");
        }
        // The load's base, first attempt only: an inconclusive attempt read afresh.
        const first = base;
        base = null;
        return publishOwnNotice(parent, signer, confirmed, { base: first });
      }, { signal: life?.signal, onWait: () => { waiting = "publish"; } });
      saved = out.notice;
      writeBase = out.base;
      writeBaseAt = Date.now();
      // No base back = the read-back could not confirm it yet (#945 N1).
      publishedUnconfirmed = out.base === null;
      justPublished = true;
      checked = false;
    } catch (e) {
      if (e instanceof LateRetryCancelled) return;
      publishError = isTicketRequired(e)
        ? "Publishing needs your account unlocked first - connect Stripe or publish an event, then come back."
        : e instanceof Error ? e.message : "Couldn't publish your notice. Nothing was changed.";
    } finally {
      publishing = false;
      if (waiting === "publish") waiting = null;
    }
  }

  const ABOUT: { field: OrganiserNoticeField; label: string; hint: string; multiline?: boolean }[] = [
    { field: "organiserName", label: "Your name or business name", hint: "The name attendees know you by - the one on their card statement is a good choice." },
    { field: "contactEmail", label: "Email for privacy questions", hint: "Where attendees can write about their details. Use a business address you check." },
    { field: "postalAddress", label: "Business address (optional)", hint: "Leave it blank rather than give a home address.", multiline: true },
    { field: "icoRegistration", label: "ICO registration number (optional)", hint: "Only if you have one. Many small organisers don't need one - the ICO's fee checker will tell you." },
  ];
</script>

<div class="editor">
  <header class="editor-head">
    <h1>Your privacy notice</h1>
    <p class="lede">
      Attendees see this next to every checkout and on your event pages and sites. We've written it from how WoCo
      works, so it's nearly done: check the choices below match how you run your events, then publish.
    </p>
  </header>

  {#if !auth.isConnected}
    <p>Sign in to set up your notice.</p>
    <button class="primary" onclick={() => loginRequest.request()}>Sign in</button>
  {:else if loading}
    <p class="muted" role="status">
      {#if waiting === "load"}
        Still checking for a saved notice - the storage network needs a minute, so we'll ask again automatically.
      {:else}
        Loading your notice…
      {/if}
    </p>
  {:else if loadError}
    <p class="error" role="alert">{loadError}</p>
    <button class="secondary" onclick={load}>Try again</button>
  {:else}
    <p class="status" class:status--ok={saved}>
      {#if saved}
        Published on {noticeDate(saved.confirmedAt)}. Attendees see this notice. Change anything below and publish again to update it.
      {:else}
        Not published yet - your tickets go on sale once it is. Attendees can't see this draft.
        {#if prefilledFrom.length}We've filled in what we could from {prefilledFrom.join(" and ")}.{/if}
      {/if}
    </p>

    <div class="layout">
      <form class="fields" onsubmit={(e) => { e.preventDefault(); void publish(); }}>
        <fieldset disabled={waiting === "publish"}>
          <legend>About you</legend>
          {#each ABOUT as { field, label, hint, multiline }}
            <label class="field">
              <span class="field-label">{label}</span>
              {#if multiline}
                <textarea rows="2" bind:value={draft[field]} maxlength={ORGANISER_NOTICE_LIMITS[field]} aria-invalid={!!fieldErrors[field]}></textarea>
              {:else}
                <input type={field === "contactEmail" ? "email" : "text"} bind:value={draft[field]} maxlength={ORGANISER_NOTICE_LIMITS[field]} aria-invalid={!!fieldErrors[field]} />
              {/if}
              <span class="field-hint">{hint}</span>
              {#if fieldErrors[field]}<span class="field-error">{fieldErrors[field]}</span>{/if}
            </label>
          {/each}
        </fieldset>

        <fieldset disabled={waiting === "publish"}>
          <legend>Who might see attendee details</legend>
          <p class="field-hint">Tick everyone who helps run your events. They only get what they need for that.</p>
          {#each NOTICE_SHARING as c}
            <label class="check"><input type="checkbox" value={c} bind:group={draft.sharing} /><span>{NOTICE_SHARING_TEXT[c]}</span></label>
          {/each}
          <label class="field">
            <span class="field-label">Anyone else (optional)</span>
            <input type="text" bind:value={draft.extraSharing} maxlength={ORGANISER_NOTICE_LIMITS.extraSharing} placeholder="For example: Our photographer" aria-invalid={!!fieldErrors.extraSharing} />
            {#if fieldErrors.extraSharing}<span class="field-error">{fieldErrors.extraSharing}</span>{/if}
          </label>
        </fieldset>

        <fieldset disabled={waiting === "publish"}>
          <legend>How long booking answers are kept</legend>
          <p class="field-hint">WoCo deletes the copy kept with each booking {ORDER_RETENTION_MONTHS} months after the event - long enough for refunds and card disputes. Buyers who join your mailing list stay on it, with their answers, until they unsubscribe. Delete any guest lists you've downloaded by then too.</p>
          <label class="field">
            <span class="field-label">Anything else you use the answers for (optional)</span>
            <input type="text" bind:value={draft.extraOrderFormUse} maxlength={ORGANISER_NOTICE_LIMITS.extraOrderFormUse} placeholder="For example: Planning the running order" aria-invalid={!!fieldErrors.extraOrderFormUse} />
            <span class="field-hint">Running the event - seating, catering, access - is already covered.</span>
            {#if fieldErrors.extraOrderFormUse}<span class="field-error">{fieldErrors.extraOrderFormUse}</span>{/if}
          </label>
        </fieldset>

        <fieldset disabled={waiting === "publish"}>
          <legend>Your mailing list</legend>
          <span class="field-label">Do you only email people about your own events?</span>
          <label class="check">
            <input type="radio" name="marketing-basis" value="own-events" bind:group={draft.marketingBasis} />
            <span>Yes. Buyers are told you'll email them about your similar events, with a box to say no.</span>
          </label>
          <label class="check">
            <input type="radio" name="marketing-basis" value="consent" bind:group={draft.marketingBasis} />
            <span>No, I also email about other people's events. Buyers tick a box if they want your emails - venues and promoters usually need this.</span>
          </label>
        </fieldset>

        <div class="publish">
          {#if todos.length}
            <p class="muted">Add an email for privacy questions when you can - until then, attendees are pointed to WoCo, who pass messages on to you.</p>
          {/if}
          <p class="note">Like any website's privacy policy, your notice is public - use business contact details, not personal ones.</p>
          <label class="check">
            <input type="checkbox" bind:checked={checked} />
            <span>I've read the preview and it describes how I handle my attendees' details.</span>
          </label>
          {#if waiting === "publish"}
            <p class="muted" role="status">Still publishing - the storage network needs a minute, so we'll try again automatically. Keep this page open until it's done.</p>
          {/if}
          {#if publishError}<p class="error" role="alert">{publishError}</p>{/if}
          {#if justPublished}
            {#if publishedUnconfirmed}
              <p class="ok" role="status">Published - it may take a minute to show. Your tickets can go on sale once it does.</p>
            {:else}
              <p class="ok" role="status">Published. Attendees now see your notice, and your tickets can go on sale.</p>
            {/if}
          {/if}
          <button class="primary" type="submit" disabled={!valid || !checked || publishing}>
            {publishing ? "Publishing…" : saved ? "Publish changes" : "Publish"}
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
  .fields { display: flex; flex-direction: column; gap: 1.25rem; }
  fieldset { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.625rem; min-width: 0; }
  legend { font-weight: 600; font-size: 1rem; margin-bottom: 0.25rem; padding: 0; }
  .field { display: flex; flex-direction: column; gap: 0.25rem; }
  .field-label { font-weight: 600; font-size: 0.875rem; }
  .field-hint { font-size: 0.8125rem; color: var(--text-muted); margin: 0; }
  .field-error, .error { font-size: 0.8125rem; color: var(--error); }
  .field input, .field textarea { font: inherit; padding: 0.5rem 0.625rem; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-input); color: var(--text); }
  .check { display: flex; gap: 0.5rem; align-items: flex-start; font-size: 0.875rem; }
  .publish { display: flex; flex-direction: column; gap: 0.625rem; padding-top: 0.75rem; border-top: 1px solid var(--border); }
  .note { font-size: 0.8125rem; color: var(--text-secondary); margin: 0; }
  .ok { font-size: 0.875rem; color: var(--success); }
  .muted { color: var(--text-muted); font-size: 0.875rem; margin: 0; }
  .preview { border: 1px solid var(--border); border-radius: var(--radius-md); padding: 1rem 1.25rem; background: var(--bg-surface); }
  .preview-head { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin: 0 0 0.75rem; }
  .primary { align-self: flex-start; padding: 0.625rem 1rem; border-radius: var(--radius-md); background: var(--accent); color: var(--accent-ink); font-weight: 600; border: 0; cursor: pointer; }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .secondary { padding: 0.5rem 0.875rem; border-radius: var(--radius-md); border: 1px solid var(--border); background: none; color: var(--text); cursor: pointer; }
</style>
