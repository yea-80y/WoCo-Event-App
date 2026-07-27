<script lang="ts">
  /**
   * One contact, in full — the screen an organiser opens to fix a typo, and the
   * one they open when a person emails asking what is held about them.
   *
   * Native <dialog> on purpose: focus trapping, Esc-to-close and inertness of the
   * page behind come from the platform, so this is a form and some CSS rather
   * than a dependency.
   *
   * `email` is deliberately not editable. It is the identity key everywhere —
   * dedupe, the suppression HMAC, the unsubscribe token — so "editing" one is
   * really deleting a person and creating another, and doing that silently in a
   * text input would detach them from their own unsubscribe.
   */
  import type { MarketingContact, ContactConsentState } from "@woco/shared";

  interface Props {
    contact: MarketingContact;
    consent: ContactConsentState;
    busy: boolean;
    onSave: (next: MarketingContact) => Promise<void>;
    onRemove: (alsoSuppress: boolean) => Promise<void>;
    onClose: () => void;
  }

  let { contact, consent, busy, onSave, onRemove, onClose }: Props = $props();

  // Snapshots `contact` at mount on purpose — this is an edit buffer, and it
  // must not be rewritten under the organiser mid-typing. The caller keys the
  // component on the email so switching contact remounts rather than mutating.
  // svelte-ignore state_referenced_locally
  let draft = $state<MarketingContact>({ ...contact });
  let confirmingRemove = $state(false);
  let alsoSuppress = $state(false);
  let actionError = $state<string | null>(null);

  const EDITABLE: Array<{ key: keyof MarketingContact; label: string; wide?: boolean }> = [
    { key: "firstName", label: "First name" },
    { key: "lastName", label: "Last name" },
    { key: "phone", label: "Phone" },
    { key: "address1", label: "Address line 1", wide: true },
    { key: "address2", label: "Address line 2", wide: true },
    { key: "city", label: "Town / city" },
    { key: "postcode", label: "Postcode" },
    { key: "country", label: "Country" },
    { key: "dob", label: "Date of birth" },
    { key: "tags", label: "Tags", wide: true },
  ];

  /** Imported figures, shown but not editable — rewriting someone's purchase
   *  history by hand makes the number a guess rather than a record. */
  const READ_ONLY: Array<{ key: keyof MarketingContact; label: string }> = [
    { key: "lastEventName", label: "Last event" },
    { key: "lastEventDate", label: "Last event date" },
    { key: "ticketsBought", label: "Tickets bought" },
    { key: "totalSpend", label: "Total spend" },
  ];

  const CONSENT_COPY: Record<ContactConsentState, string> = {
    "opted-in": "Ticked the marketing box at checkout. The wording they agreed to and the date are recorded.",
    imported: "Added by import. Your import warranty is the basis for mailing them — there is no record of this person agreeing.",
    unsubscribed: "Unsubscribed. They stay unsubscribed through any re-import, and removing them here does not change that.",
  };

  const dirty = $derived(EDITABLE.some(({ key }) => (draft[key] ?? "") !== (contact[key] ?? "")));
  const hasHistory = $derived(READ_ONLY.some(({ key }) => contact[key]));

  function fullName(c: MarketingContact): string {
    return [c.firstName, c.lastName].filter(Boolean).join(" ");
  }

  async function save(): Promise<void> {
    actionError = null;
    try {
      // Blank an input and the field goes away rather than becoming "" — an
      // empty string would count as a value on the next merge and could
      // overwrite something better.
      const next = { ...draft };
      for (const { key } of EDITABLE) {
        const v = (next[key] as string | undefined)?.trim();
        if (v) (next[key] as string) = v;
        else delete next[key];
      }
      await onSave(next);
    } catch (err) {
      actionError = err instanceof Error ? err.message : "Could not save.";
    }
  }

  async function remove(): Promise<void> {
    actionError = null;
    try {
      await onRemove(alsoSuppress);
    } catch (err) {
      actionError = err instanceof Error ? err.message : "Could not remove.";
    }
  }

  /** Bind showModal to mount so the platform sets up focus + inertness. */
  function modal(node: HTMLDialogElement) {
    node.showModal();
    return { destroy: () => node.close() };
  }
</script>

<dialog class="sheet" use:modal onclose={onClose} onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <form method="dialog" class="inner" onsubmit={(e) => e.preventDefault()}>
    <header class="head">
      <div class="who">
        <h3>{fullName(contact) || "No name on record"}</h3>
        <span class="email">{contact.email}</span>
      </div>
      <button type="button" class="x" onclick={onClose} aria-label="Close">✕</button>
    </header>

    <div class="consent consent--{consent}">
      <span class="consent-tag">{consent.replace("-", " ")}</span>
      <p>{CONSENT_COPY[consent]}</p>
    </div>

    <div class="grid">
      {#each EDITABLE as f (f.key)}
        <label class="field" class:wide={f.wide}>
          <span>{f.label}</span>
          <input type="text" value={draft[f.key] ?? ""}
            oninput={(e) => ((draft[f.key] as string) = e.currentTarget.value)} />
        </label>
      {/each}
    </div>

    {#if hasHistory}
      <div class="facts">
        <h4>History with you</h4>
        <dl>
          {#each READ_ONLY as f (f.key)}
            {#if contact[f.key]}
              <dt>{f.label}</dt>
              <dd>{contact[f.key]}</dd>
            {/if}
          {/each}
        </dl>
      </div>
    {/if}

    <div class="facts">
      <h4>Where this came from</h4>
      <dl>
        <dt>Source</dt>
        <dd>{contact.source?.replace(/^csv:/, "") ?? "Not recorded"}</dd>
        <dt>Added</dt>
        <dd>{new Date(contact.addedAt).toLocaleDateString()}</dd>
      </dl>
    </div>

    {#if actionError}<p class="err">{actionError}</p>{/if}

    <footer class="foot">
      {#if confirmingRemove}
        <label class="also">
          <input type="checkbox" bind:checked={alsoSuppress} />
          Also unsubscribe them, so a re-import cannot add them back
        </label>
        <div class="row">
          <button type="button" class="btn-danger" disabled={busy} onclick={() => void remove()}>
            {busy ? "Removing…" : "Remove from list"}
          </button>
          <button type="button" class="btn-ghost" onclick={() => (confirmingRemove = false)}>Keep</button>
        </div>
      {:else}
        <div class="row">
          <button type="button" class="btn-primary" disabled={!dirty || busy} onclick={() => void save()}>
            {busy ? "Saving…" : "Save changes"}
          </button>
          <button type="button" class="btn-ghost danger" onclick={() => (confirmingRemove = true)}>Remove</button>
        </div>
      {/if}
    </footer>
  </form>
</dialog>

<style>
  .sheet {
    border: none;
    padding: 0;
    background: transparent;
    color: var(--text);
    max-width: none;
    max-height: none;
    width: 100%;
    height: 100%;
    margin: 0;
  }

  .sheet::backdrop { background: rgba(0, 0, 0, 0.6); }

  .inner {
    position: absolute;
    inset: auto 0 0 0;
    max-height: 88vh;
    overflow-y: auto;
    background: var(--bg-elevated);
    border-top: 1px solid var(--border);
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    padding: 1rem 1rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* Desktop: a side drawer. Same markup, so the sheet keeps one behaviour on
     touch and reading order never changes. */
  @media (min-width: 720px) {
    .inner {
      inset: 0 0 0 auto;
      width: min(440px, 100%);
      max-height: none;
      border-radius: 0;
      border-top: none;
      border-left: 1px solid var(--border);
      padding: 1.25rem;
    }
  }

  .head { display: flex; align-items: flex-start; gap: 0.75rem; }
  .who { flex: 1; min-width: 0; }

  h3 {
    font-family: var(--font-display);
    font-size: 1.0625rem;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .email {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }

  .x { color: var(--text-muted); font-size: 0.875rem; padding: 0.25rem; flex: none; }
  .x:hover { color: var(--text); }

  .consent {
    border: 1px solid var(--border);
    border-left-width: 3px;
    border-radius: var(--radius-md);
    padding: 0.625rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .consent p { margin: 0; font-size: 0.75rem; line-height: 1.5; color: var(--text-secondary); }

  .consent--opted-in { border-left-color: var(--accent); }
  .consent--imported { border-left-color: var(--border-hover); }
  .consent--unsubscribed { border-left-color: var(--error); }

  .consent-tag {
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }
  .consent--opted-in .consent-tag { color: var(--accent-text); }

  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.625rem;
  }

  .field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
  .field.wide { grid-column: 1 / -1; }

  .field span {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }

  .field input {
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 0.5rem 0.625rem;
    color: var(--text);
    font-size: 0.875rem;
    width: 100%;
  }

  .field input:focus-visible { outline: none; border-color: var(--border-focus); }

  .facts h4 {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    margin: 0 0 0.4rem;
    font-weight: 400;
  }

  dl {
    margin: 0;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.2rem 0.75rem;
    font-size: 0.8125rem;
  }
  dt { color: var(--text-muted); }
  dd { margin: 0; color: var(--text-secondary); overflow-wrap: anywhere; }

  .err { color: var(--error); font-size: 0.8125rem; margin: 0; }

  .foot {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    border-top: 1px solid var(--border);
    padding-top: 0.875rem;
  }

  .row { display: flex; gap: 0.5rem; flex-wrap: wrap; }

  .also {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }

  .btn-primary {
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 700;
    font-size: 0.875rem;
    padding: 0.5rem 1rem;
    border-radius: var(--radius-md);
  }
  .btn-primary:disabled { opacity: 0.4; }

  .btn-ghost {
    border: 1px solid var(--border);
    color: var(--text-secondary);
    font-size: 0.875rem;
    padding: 0.5rem 1rem;
    border-radius: var(--radius-md);
  }
  .btn-ghost:hover { border-color: var(--border-hover); color: var(--text); }
  .btn-ghost.danger:hover { border-color: var(--error); color: var(--error); }

  .btn-danger {
    background: var(--error-subtle);
    border: 1px solid var(--error);
    color: var(--error);
    font-size: 0.875rem;
    padding: 0.5rem 1rem;
    border-radius: var(--radius-md);
  }
</style>
