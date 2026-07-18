<script lang="ts">
  import type { MarketingContact, MarketingListMeta } from "@woco/shared";
  import { deriveEncryptionKeypairFromPodSeed, sealJson, openJson } from "@woco/shared";
  import type { MarketingListPayload } from "@woco/shared";
  import { restorePodSeed } from "../../auth/pod-identity.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import {
    getMarketingList,
    uploadMarketingList,
    checkMarketingEmails,
    suppressContacts,
  } from "../../api/marketing.js";
  import CsvImportWizard from "./CsvImportWizard.svelte";
  import ContactSearch from "./ContactSearch.svelte";
  import MarketingComposer from "./MarketingComposer.svelte";
  import SendingDomainPanel from "./SendingDomainPanel.svelte";

  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let meta = $state<MarketingListMeta | null>(null);
  let contacts = $state<MarketingContact[]>([]);
  let suppressedEmails = $state<Set<string>>(new Set());
  let saving = $state(false);
  let wizardOpen = $state(false);
  let panel = $state<"contacts" | "compose" | null>(null);

  /** X25519 keys derived from the organiser's POD seed (decrypt + re-seal). */
  async function getKeys(): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array } | null> {
    if (!auth.podAddress) return null;
    let podSeed = await restorePodSeed(auth.podAddress);
    if (!podSeed) {
      const pk = await auth.ensurePodIdentity();
      if (!pk) return null;
      podSeed = await restorePodSeed(auth.podAddress);
    }
    if (!podSeed) return null;
    return deriveEncryptionKeypairFromPodSeed(podSeed);
  }

  async function refreshSuppressed(list: MarketingContact[]): Promise<void> {
    if (list.length === 0) {
      suppressedEmails = new Set();
      return;
    }
    try {
      const res = await checkMarketingEmails(list.map((c) => c.email));
      suppressedEmails = new Set(res.suppressed);
    } catch {
      // Non-fatal — counts just show without the suppressed line
    }
  }

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      const resp = await getMarketingList();
      if (!resp) {
        meta = null;
        contacts = [];
        return;
      }
      meta = resp.meta;
      const keys = await getKeys();
      if (!keys) {
        loadError = "Sign in and unlock your identity to open your audience.";
        return;
      }
      const payload = await openJson<MarketingListPayload>(keys.privateKey, resp.sealedList);
      contacts = payload.contacts;
      await refreshSuppressed(contacts);
    } catch (err) {
      loadError = err instanceof Error ? err.message : "Could not open your audience.";
    } finally {
      loading = false;
    }
  }

  /** Re-seal + upload the full list — the single write path for every change. */
  async function commitList(next: MarketingContact[]): Promise<void> {
    const keys = await getKeys();
    if (!keys) throw new Error("Identity locked — sign in to save changes");
    saving = true;
    try {
      const sealed = await sealJson(keys.publicKey, { version: 1, contacts: next } satisfies MarketingListPayload);
      meta = await uploadMarketingList(sealed, next.map((c) => c.email));
      contacts = next;
      await refreshSuppressed(next);
    } finally {
      saving = false;
    }
  }

  async function handleWizardCommit(added: MarketingContact[]): Promise<void> {
    const have = new Set(contacts.map((c) => c.email));
    const merged = [...contacts, ...added.filter((c) => !have.has(c.email))];
    await commitList(merged);
    wizardOpen = false;
  }

  async function handleDelete(email: string, alsoSuppress: boolean): Promise<void> {
    await commitList(contacts.filter((c) => c.email !== email));
    if (alsoSuppress) {
      await suppressContacts([email]);
      await refreshSuppressed(contacts);
    }
  }

  const reachable = $derived(contacts.filter((c) => !suppressedEmails.has(c.email)).length);

  // Single-fire load once auth is ready (covers both mount-already-connected
  // and connect-after-mount without double-fetching).
  let loadStarted = false;
  $effect(() => {
    if (auth.ready && auth.isConnected && !loadStarted) {
      loadStarted = true;
      void load();
    }
  });
</script>

<div class="audience">
  <header class="head">
    <div>
      <h2>Audience</h2>
      <p class="sub">Your marketing list — encrypted to your identity, only you can read it.</p>
    </div>
  </header>

  {#if !auth.isConnected}
    <div class="empty">
      <p>Sign in to manage your audience.</p>
      <button class="btn-primary" onclick={() => loginRequest.request()}>Sign in</button>
    </div>
  {:else if loading}
    <div class="empty"><p class="muted">Opening your audience…</p></div>
  {:else if loadError}
    <div class="empty">
      <p class="err">{loadError}</p>
      <button class="btn-ghost" onclick={() => void load()}>Try again</button>
    </div>
  {:else}
    {#if contacts.length === 0 && !wizardOpen}
      <div class="empty invite">
        <span class="mark" aria-hidden="true"></span>
        <h3>Bring your people with you</h3>
        <p class="muted">
          Import the customer lists you've exported from Skiddle, Fatsoma, RA or any other
          platform. Contacts are encrypted before they're stored — and anyone who
          unsubscribes stays unsubscribed, even if you re-import the same file.
        </p>
        <button class="btn-primary" onclick={() => (wizardOpen = true)}>Import contacts</button>
      </div>
    {:else}
      <div class="stats" role="group" aria-label="Audience summary">
        <div class="stat">
          <span class="stat-n">{contacts.length.toLocaleString()}</span>
          <span class="stat-l">contacts</span>
        </div>
        <div class="stat">
          <span class="stat-n">{reachable.toLocaleString()}</span>
          <span class="stat-l">reachable</span>
        </div>
        <div class="stat" class:dim={suppressedEmails.size === 0}>
          <span class="stat-n">{suppressedEmails.size.toLocaleString()}</span>
          <span class="stat-l">unsubscribed</span>
        </div>
        {#if meta}
          <div class="stat updated">
            <span class="stat-n small">{new Date(meta.updatedAt).toLocaleDateString()}</span>
            <span class="stat-l">last updated</span>
          </div>
        {/if}
      </div>

      <div class="actions">
        <button class="btn-primary" onclick={() => (wizardOpen = !wizardOpen)}>
          {wizardOpen ? "Close import" : "Import contacts"}
        </button>
        <button
          class="btn-ghost"
          class:active={panel === "compose"}
          onclick={() => (panel = panel === "compose" ? null : "compose")}
        >Compose broadcast</button>
        <button
          class="btn-ghost"
          class:active={panel === "contacts"}
          onclick={() => (panel = panel === "contacts" ? null : "contacts")}
        >Browse contacts</button>
      </div>
    {/if}

    {#if wizardOpen}
      <CsvImportWizard
        existingEmails={new Set(contacts.map((c) => c.email))}
        busy={saving}
        onCommit={handleWizardCommit}
        onCancel={() => (wizardOpen = false)}
      />
    {/if}

    {#if panel === "contacts" && contacts.length > 0}
      <ContactSearch {contacts} {suppressedEmails} busy={saving} onDelete={handleDelete} />
    {/if}

    {#if panel === "compose" && contacts.length > 0}
      <MarketingComposer {contacts} {suppressedEmails} />
    {/if}

    <SendingDomainPanel />
  {/if}
</div>

<style>
  .audience {
    max-width: 640px;
    margin: 0 auto;
    padding: 1rem 1rem 4rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .head h2 {
    font-family: var(--font-display);
    font-size: 1.375rem;
    letter-spacing: -0.01em;
    margin: 0;
  }

  .sub {
    color: var(--text-muted);
    font-size: 0.8125rem;
    margin: 0.25rem 0 0;
  }

  .empty {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 2.5rem 1.5rem;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.875rem;
  }

  .invite h3 {
    font-family: var(--font-display);
    font-size: 1.125rem;
    margin: 0;
  }

  .invite p {
    max-width: 42ch;
    line-height: 1.55;
    margin: 0;
  }

  .mark {
    width: 12px;
    height: 12px;
    background: var(--accent);
    transform: rotate(45deg);
  }

  .muted { color: var(--text-muted); font-size: 0.875rem; }
  .err { color: var(--error); font-size: 0.875rem; }

  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .stat {
    padding: 0.875rem 1rem;
    background: var(--bg-surface);
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .stat + .stat { border-left: 1px solid var(--border); }
  .stat.dim .stat-n { color: var(--text-dim); }

  .stat-n {
    font-family: var(--font-mono);
    font-size: 1.25rem;
    color: var(--text);
  }

  .stat-n.small { font-size: 0.875rem; padding-top: 0.3rem; }

  .stat-l {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .btn-primary {
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 700;
    font-size: 0.875rem;
    padding: 0.625rem 1.125rem;
    border-radius: var(--radius-md);
    transition: background var(--transition);
  }

  .btn-primary:hover { background: var(--accent-hover); }

  .btn-ghost {
    border: 1px solid var(--border);
    color: var(--text-secondary);
    font-size: 0.875rem;
    padding: 0.625rem 1.125rem;
    border-radius: var(--radius-md);
    transition: border-color var(--transition), color var(--transition);
  }

  .btn-ghost:hover { border-color: var(--border-hover); color: var(--text); }
  .btn-ghost.active { border-color: var(--accent); color: var(--accent-text); }
</style>
