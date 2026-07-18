<script lang="ts">
  import type { MarketingContact } from "@woco/shared";

  interface Props {
    contacts: MarketingContact[];
    suppressedEmails: Set<string>;
    busy: boolean;
    onDelete: (email: string, alsoSuppress: boolean) => Promise<void>;
  }

  let { contacts, suppressedEmails, busy, onDelete }: Props = $props();

  let query = $state("");
  let confirmingEmail = $state<string | null>(null);
  let alsoSuppress = $state(false);
  let error = $state<string | null>(null);

  const MAX_SHOWN = 100;

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts.slice(0, MAX_SHOWN);
    return contacts
      .filter((c) =>
        c.email.includes(q) ||
        (c.firstName ?? "").toLowerCase().includes(q) ||
        (c.lastName ?? "").toLowerCase().includes(q) ||
        (c.postcode ?? "").toLowerCase().includes(q),
      )
      .slice(0, MAX_SHOWN);
  });

  function displayName(c: MarketingContact): string {
    const name = [c.firstName, c.lastName].filter(Boolean).join(" ");
    return name || "—";
  }

  async function remove(email: string): Promise<void> {
    error = null;
    try {
      await onDelete(email, alsoSuppress);
      confirmingEmail = null;
      alsoSuppress = false;
    } catch (err) {
      error = err instanceof Error ? err.message : "Delete failed.";
    }
  }
</script>

<section class="search" aria-label="Browse contacts">
  <input
    class="search-input"
    type="search"
    placeholder="Search by email, name or postcode — also how you handle GDPR requests"
    bind:value={query}
  />

  <div class="rows" role="list">
    {#each filtered as c (c.email)}
      <div class="row" role="listitem" class:suppressed={suppressedEmails.has(c.email)}>
        <div class="row-main">
          <span class="row-email">{c.email}</span>
          <span class="row-meta">
            {displayName(c)}{c.postcode ? ` · ${c.postcode}` : ""}
            {#if c.source}<span class="row-source"> · {c.source.replace(/^csv:/, "")}</span>{/if}
          </span>
        </div>
        {#if suppressedEmails.has(c.email)}
          <span class="chip">unsubscribed</span>
        {/if}
        {#if confirmingEmail === c.email}
          <div class="confirm">
            <label class="confirm-suppress">
              <input type="checkbox" bind:checked={alsoSuppress} />
              <span class="tick" aria-hidden="true"></span>
              also unsubscribe them
            </label>
            <button class="btn-danger" disabled={busy} onclick={() => void remove(c.email)}>
              {busy ? "Removing…" : "Remove"}
            </button>
            <button class="btn-ghost sm" onclick={() => { confirmingEmail = null; alsoSuppress = false; }}>Keep</button>
          </div>
        {:else}
          <button class="btn-ghost sm" onclick={() => { confirmingEmail = c.email; alsoSuppress = false; }}>Remove</button>
        {/if}
      </div>
    {:else}
      <p class="none">No contacts match "{query}".</p>
    {/each}
  </div>

  {#if contacts.length > MAX_SHOWN && !query.trim()}
    <p class="cap-note">Showing the first {MAX_SHOWN} of {contacts.length.toLocaleString()} — search to find anyone.</p>
  {/if}
  {#if error}<p class="err">{error}</p>{/if}
</section>

<style>
  .search {
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
  .search-input:focus { border-color: var(--accent); outline: none; }
  .search-input::placeholder { color: var(--text-dim); }

  .rows { display: flex; flex-direction: column; }

  .row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0.25rem;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .row:last-child { border-bottom: none; }
  .row.suppressed .row-email { color: var(--text-dim); text-decoration: line-through; }

  .row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.1rem; }

  .row-email {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .row-meta { font-size: 0.75rem; color: var(--text-muted); }
  .row-source { color: var(--text-dim); }

  .chip {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.15rem 0.4rem;
    white-space: nowrap;
  }

  .confirm { display: flex; align-items: center; gap: 0.625rem; flex-wrap: wrap; }

  .confirm-suppress {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.75rem;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .confirm-suppress input { position: absolute; opacity: 0; pointer-events: none; }
  .tick {
    width: 15px;
    height: 15px;
    border: 1.5px solid var(--border-hover);
    border-radius: var(--radius-sm);
    position: relative;
    transition: background var(--transition), border-color var(--transition);
  }
  .confirm-suppress input:checked + .tick { background: var(--accent); border-color: var(--accent); }
  .confirm-suppress input:checked + .tick::after {
    content: "";
    position: absolute;
    left: 4px;
    top: 0;
    width: 4px;
    height: 8px;
    border: solid var(--accent-ink);
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }
  .confirm-suppress input:focus-visible + .tick { outline: 2px solid var(--accent); outline-offset: 2px; }

  .btn-danger {
    background: var(--error-subtle);
    color: var(--error);
    border: 1px solid transparent;
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.375rem 0.75rem;
    border-radius: var(--radius-sm);
    transition: border-color var(--transition);
  }
  .btn-danger:hover:not(:disabled) { border-color: var(--error); }
  .btn-danger:disabled { opacity: 0.5; }

  .btn-ghost {
    border: 1px solid var(--border);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    transition: border-color var(--transition), color var(--transition);
  }
  .btn-ghost:hover { border-color: var(--border-hover); color: var(--text); }
  .btn-ghost.sm { font-size: 0.75rem; padding: 0.375rem 0.75rem; }

  .none, .cap-note { color: var(--text-muted); font-size: 0.8125rem; margin: 0; }
  .err { color: var(--error); font-size: 0.8125rem; margin: 0; }
</style>
