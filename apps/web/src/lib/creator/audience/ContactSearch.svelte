<script lang="ts">
  /**
   * The contact list: search, the consent filter from the ledger above, and the
   * way into one person's record.
   *
   * A row is a summary and a target, not a workbench — every edit and both
   * destructive actions live in ContactDetail, so there is one place where a
   * change to a person happens and one place to get that right.
   */
  import type { MarketingContact, ContactConsentState } from "@woco/shared";
  import { contactConsentState } from "@woco/shared";
  import ContactDetail from "./ContactDetail.svelte";

  interface Props {
    contacts: MarketingContact[];
    suppressedEmails: Set<string>;
    consentedEmails: Set<string>;
    filter: ContactConsentState | null;
    busy: boolean;
    onSave: (email: string, next: MarketingContact) => Promise<void>;
    onDelete: (email: string, alsoSuppress: boolean) => Promise<void>;
  }

  let {
    contacts,
    suppressedEmails,
    consentedEmails,
    filter,
    busy,
    onSave,
    onDelete,
  }: Props = $props();

  let query = $state("");
  let openEmail = $state<string | null>(null);

  /** The list runs to 20k. Rendering all of it costs more than it tells anyone,
   *  so the page shows a window and search is how you reach the rest. */
  const MAX_SHOWN = 100;

  const stateOf = (c: MarketingContact): ContactConsentState =>
    contactConsentState(c.email, suppressedEmails, consentedEmails);

  /** Everything a person might type into the box, including the address they
   *  are calling about. Built per contact, not per keystroke-per-field. */
  function haystack(c: MarketingContact): string {
    return [c.email, c.firstName, c.lastName, c.phone, c.address1, c.address2, c.city, c.postcode]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  const matching = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const out: MarketingContact[] = [];
    for (const c of contacts) {
      if (filter && stateOf(c) !== filter) continue;
      if (q && !haystack(c).includes(q)) continue;
      out.push(c);
    }
    return out;
  });

  const shown = $derived(matching.slice(0, MAX_SHOWN));
  const open = $derived(contacts.find((c) => c.email === openEmail) ?? null);

  function displayName(c: MarketingContact): string {
    return [c.firstName, c.lastName].filter(Boolean).join(" ") || "No name";
  }

  /** The line under the address: whatever this contact actually has. */
  function subtitle(c: MarketingContact): string {
    return [displayName(c), c.city || c.postcode, c.source?.replace(/^csv:/, "")]
      .filter(Boolean)
      .join(" · ");
  }
</script>

<section class="list" aria-label="Contacts">
  <input
    class="search-input"
    type="search"
    placeholder="Search name, email, address or postcode"
    aria-label="Search contacts"
    bind:value={query}
  />

  {#if shown.length > 0}
    <ul class="rows">
      {#each shown as c (c.email)}
        {@const s = stateOf(c)}
        <li>
          <button type="button" class="row" onclick={() => (openEmail = c.email)}>
            <span class="dot dot--{s}" aria-hidden="true"></span>
            <span class="row-main">
              <span class="row-email">{c.email}</span>
              <span class="row-meta">{subtitle(c)}</span>
            </span>
            {#if s === "unsubscribed"}
              <span class="chip">unsubscribed</span>
            {:else if s === "opted-in"}
              <span class="chip chip--in">opted in</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="none">
      {#if query.trim()}
        Nothing matches "{query}".
      {:else}
        No contacts in this band.
      {/if}
    </p>
  {/if}

  {#if matching.length > MAX_SHOWN}
    <p class="cap-note">
      Showing {MAX_SHOWN} of {matching.length.toLocaleString()} — keep typing to narrow it down.
    </p>
  {/if}
</section>

{#if open}
  <!-- Keyed so a different contact gets a fresh edit buffer rather than
       inheriting the last one's unsaved draft. -->
  {#key open.email}
  <ContactDetail
    contact={open}
    consent={stateOf(open)}
    {busy}
    onSave={async (next) => { await onSave(open!.email, next); openEmail = null; }}
    onRemove={async (alsoSuppress) => { await onDelete(open!.email, alsoSuppress); openEmail = null; }}
    onClose={() => (openEmail = null)}
  />
  {/key}
{/if}

<style>
  .list {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-surface);
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .search-input {
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text);
    padding: 0.625rem 0.75rem;
    font-size: 0.8125rem;
    width: 100%;
    transition: border-color var(--transition);
  }
  .search-input:focus-visible { border-color: var(--accent); outline: none; }
  .search-input::placeholder { color: var(--text-dim); }

  /* A real <ul>/<li>, not roles on buttons — a <button> cannot be a listitem,
     and `display: contents` on the <li> has a history of dropping it out of the
     accessibility tree. The li stays a plain block and the button fills it. */
  .rows { list-style: none; margin: 0; padding: 0; }

  .row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.625rem 0.5rem;
    border-bottom: 1px solid var(--border);
    text-align: left;
    width: 100%;
    border-radius: var(--radius-sm);
    transition: background var(--transition);
  }
  .rows li:last-child .row { border-bottom: none; }
  .row:hover { background: var(--bg-surface-hover); }
  .row:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }

  /* Repeats the ledger's key, so the band you filtered by and the rows you got
     back are visibly the same thing. */
  .dot { width: 6px; height: 6px; border-radius: 1px; flex: none; }
  .dot--opted-in { background: var(--accent); }
  .dot--imported { background: var(--border-hover); }
  .dot--unsubscribed { background: repeating-linear-gradient(135deg, var(--error) 0 2px, transparent 2px 4px); }

  .row-main { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; flex: 1; }

  .row-email {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-meta {
    font-size: 0.75rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chip {
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.15rem 0.35rem;
    flex: none;
  }
  .chip--in { color: var(--accent-text); border-color: var(--accent-subtle); }

  .none, .cap-note {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0;
  }
</style>
