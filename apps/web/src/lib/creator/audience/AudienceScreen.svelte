<script lang="ts">
  import type { MarketingContact, MarketingListMeta, ContactConsentState, ListStorageVerdict } from "@woco/shared";
  import { contactConsentState } from "@woco/shared";
  import type { MarketingListPayload, MarketingListTombstone } from "@woco/shared";
  import UnlockPanel from "../../components/auth/UnlockPanel.svelte";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import {
    getMarketingList,
    uploadMarketingList,
    checkMarketingEmails,
    suppressContacts,
  } from "../../api/marketing.js";
  import { markAudienceImported } from "../home/onboarding.svelte.js";
  import { router } from "../../router/router.svelte.js";
  import CsvImportWizard from "./CsvImportWizard.svelte";
  import ConsentLedger from "./ConsentLedger.svelte";
  import ContactSearch from "./ContactSearch.svelte";
  import AudienceSyncStatus from "./AudienceSyncStatus.svelte";
  import MarketingComposer from "./MarketingComposer.svelte";
  import SendingDomainPanel from "./SendingDomainPanel.svelte";
  import { FEATURES } from "@woco/shared";
  import StripeVerifyGate from "../events/StripeVerifyGate.svelte";
  import { onMount } from "svelte";
  import { listKeysOf } from "./list-keys.js";
  import { buildContactsCsv, contactsCsvFilename } from "./csv-export.js";
  import { downloadCsv } from "../../utils/csv.js";
  import {
    addRemoved,
    clearRemoved,
    isListChanged,
    isListMissing,
    normaliseRemoved,
    saveListChange,
    type ListState,
  } from "./audience-sync.js";
  import { onListWritten, syncAudience, withListLock } from "./audience-sync.svelte.js";

  /** Said once a save lost the race to another tab or device and the screen reloaded. */
  const LIST_CHANGED_NOTICE =
    "Your list was changed in another tab or on another device, so nothing was saved. We've loaded the latest version - please make your change again.";

  let loading = $state(true);
  let loadError = $state<string | null>(null);
  // The list exists but the account keys are locked on this device (#746 fix 1):
  // it opens on one tap, never by itself on page open.
  let listLocked = $state(false);
  /** On record but not found in storage. Replaced only by the organiser's "Start a new list". */
  let listMissing = $state<{ count: number; updatedAt: string; storage: ListStorageVerdict } | null>(null);
  let startNewError = $state<string | null>(null);
  let meta = $state<MarketingListMeta | null>(null);
  let contacts = $state<MarketingContact[]>([]);
  /** Deleted by the organiser: the automatic add of opted-in buyers never brings these back. */
  let removed = $state<MarketingListTombstone[]>([]);
  /** A save that lost the race to another tab or device: shown above the list until the next save. */
  let listNotice = $state<string | null>(null);
  let suppressedEmails = $state<Set<string>>(new Set());
  /** Contacts who ticked the opt-in themselves — the server holds the evidence,
   *  keyed by hash, so this is the only way the client can know. */
  let consentedEmails = $state<Set<string>>(new Set());
  /** Buyers who were offered "Don't email me" at checkout and left it alone - the
   *  soft opt-in. Evidence exists, for the organiser's own similar events only. */
  let softOptInEmails = $state<Set<string>>(new Set());
  /** Contacts this organiser has already reached through WoCo without a bounce
   *  (or who said yes at their checkout, either basis) — they skip paced sending (#619). */
  let provenEmails = $state<Set<string>>(new Set());
  /** The consent/suppression read failed, so the labels and counts below are
   *  not evidence of anything — distinct from everyone being 'imported'. */
  let consentUnknown = $state(false);
  let saving = $state(false);
  let wizardOpen = $state(false);
  let panel = $state<"contacts" | "compose" | null>(null);

  /** ?announce={eventId} — the post-publish prompt: open the composer with
   *  that event preselected. It opens with an empty audience too: the composer
   *  is where you find out what a WoCo email looks like, and being sent there
   *  with nothing to look at was the worse answer (#135). */
  const announceEventId = $derived(router.params.announce);
  $effect(() => {
    if (announceEventId) panel = "compose";
  });
  let consentFilter = $state<ContactConsentState | null>(null);
  /** Abuse gate (#59): sending requires a Stripe-verified organiser. */
  let stripeVerified = $state<boolean | null>(null);

  /**
   * The organiser's X-Wing keys (#642), derived from the identity seed, plus the
   * seal context that binds the list to this account. The post-quantum code is
   * loaded here, on first use, never with the page.
   */
  async function getKeys(prompt = false, toSeal = false) {
    const secrets = await getAccountSecrets(prompt, toSeal);
    if (!secrets || !auth.parent) return null;
    return listKeysOf(secrets, auth.parent);
  }

  /** The account's secrets, unlocking first - only when `prompt`, which only a tap
   *  passes - if they are locked or not yet on this device. */
  async function getAccountSecrets(prompt: boolean, toSeal: boolean): Promise<{ current: string; all: string[] } | null> {
    // Sealing needs the CONFIRMED current generation (#186) - a list sealed to keys the
    // account left would open for a removed passkey. Opening takes whatever is held.
    const secrets = await auth.getAccountSecrets({ toSeal });
    if (secrets || !prompt) return secrets;
    if (!(await auth.ensureAccountSetup({ identity: true }))) return null;
    return auth.getAccountSecrets({ toSeal });
  }

  /** One round trip gives both server-held states; the third (imported) is what
   *  is left over, so it needs no call of its own. */
  async function refreshConsentStates(list: MarketingContact[]): Promise<void> {
    if (list.length === 0) {
      suppressedEmails = new Set();
      consentedEmails = new Set();
      softOptInEmails = new Set();
      provenEmails = new Set();
      return;
    }
    try {
      const res = await checkMarketingEmails(list.map((c) => c.email));
      suppressedEmails = new Set(res.suppressed);
      consentedEmails = new Set(res.consented ?? []);
      softOptInEmails = new Set(res.softOptIn ?? []);
      provenEmails = new Set(res.proven ?? []);
      consentUnknown = false;
    } catch {
      // Non-fatal for sending — the server is the enforcement boundary and
      // refuses suppressed addresses whatever this screen believes. But it is
      // NOT the cautious reading it was described as: an empty suppression set
      // renders an unsubscribed contact as an ordinary one, and the counts then
      // report "0 unsubscribed" as though that had been checked (#291). Say the
      // states are unknown instead of showing states we did not read.
      consentUnknown = true;
    }
  }

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    listLocked = false;
    listMissing = null;
    try {
      // Read under the list lock: a sync write landing mid-read would otherwise be
      // painted over by the older copy this read fetched.
      const locked = await withListLock(async () => {
        const resp = await getMarketingList();
        if (!resp) {
          meta = null;
          contacts = [];
          removed = [];
          return false;
        }
        meta = resp.meta;
        if (resp.sealedList === null) {
          contacts = [];
          removed = [];
          listMissing = { count: resp.meta.count, updatedAt: resp.meta.updatedAt, storage: resp.storage };
          return false;
        }
        const keys = await getKeys();
        if (!keys) return true;
        const { openJsonWithAnyKey } = await import("../../keyring/order-keys.js");
        const payload = await openJsonWithAnyKey<MarketingListPayload>(keys.secretKeys, resp.sealedList, keys.ctx);
        contacts = payload.contacts;
        removed = normaliseRemoved(payload.removed);
        return false;
      });
      if (locked) {
        if (auth.parent) listLocked = true;
        else loadError = "Sign in and unlock your identity to open your audience.";
        return;
      }
      if (listMissing) return;
      await refreshConsentStates(contacts);
      // Opted-in buyers since the last check join now; the screen takes the result through onListWritten.
      void syncAudience();
    } catch (err) {
      // A list saved before #642 was sealed with the retired X25519 format. Say so
      // plainly: the fix is to import it again, not to retry.
      loadError =
        err instanceof Error && err.name === "UnsupportedSealedBoxError"
          ? "Your saved audience uses an older format that can no longer be opened. Import your contacts again to replace it."
          : err instanceof Error
            ? err.message
            : "Could not open your audience.";
    } finally {
      loading = false;
    }
  }

  /**
   * Re-seal + upload the full list — the single write path for every change.
   * `change` is the edit as an operation, applied inside the list lock to the list
   * as it is stored NOW (re-read and opened), and written only if nothing saved in
   * between - so a stale tab can never bring back a deleted contact or wipe a
   * tombstone. Lost that race: the screen reloads and says so plainly.
   */
  async function commitList(
    change: (list: ListState) => ListState,
    opts: { replaceMissing?: boolean } = {},
  ): Promise<void> {
    const keys = await getKeys(true, true);
    if (!keys) throw new Error("Identity locked — sign in to save changes");
    saving = true;
    let changedElsewhere = false;
    let missing = false;
    try {
      await withListLock(async () => {
        const { openJsonWithAnyKey } = await import("../../keyring/order-keys.js");
        try {
          const saved = await saveListChange(
            {
              async readList() {
                const resp = await getMarketingList();
                return resp ? { sealedList: resp.sealedList, updatedAt: resp.meta.updatedAt } : null;
              },
              openList: (box) => openJsonWithAnyKey<MarketingListPayload>(keys.secretKeys, box, keys.ctx),
              sealList: (payload) => keys.box.sealBoxJsonCompressed(keys.publicKey, payload, keys.ctx),
              writeList: (sealed, emails, ifUpdatedAt) => uploadMarketingList(sealed, emails, { ifUpdatedAt }),
            },
            change,
            opts,
          );
          contacts = saved.payload.contacts;
          removed = normaliseRemoved(saved.payload.removed);
          meta = saved.meta;
          listNotice = null;
        } catch (err) {
          if (isListMissing(err)) missing = true;
          else if (isListChanged(err)) changedElsewhere = true;
          else throw err;
        }
      });
      if (changedElsewhere) {
        await load();
        listNotice = LIST_CHANGED_NOTICE;
        throw new Error(LIST_CHANGED_NOTICE);
      }
      // Lost from storage since the screen opened it: show that, never save over it.
      if (missing) {
        await load();
        throw new Error("Your saved contact list can't be found, so nothing was saved.");
      }
      if (contacts.length > 0 && auth.parent) markAudienceImported(auth.parent);
      await refreshConsentStates(contacts);
    } finally {
      saving = false;
    }
  }

  /** The organiser's tap - the only write that may replace a list that can't be found. */
  async function startNewList(): Promise<void> {
    startNewError = null;
    try {
      await commitList(() => ({ contacts: [], removed: [] }), { replaceMissing: true });
      listMissing = null;
      // The new list's stamp makes the check read every event again: opted-in buyers come back.
      void syncAudience({ force: true });
    } catch (err) {
      startNewError = err instanceof Error ? err.message : "Could not start a new list.";
    }
  }

  async function handleWizardCommit(added: MarketingContact[]): Promise<void> {
    const organiser = auth.parent;
    if (!organiser) throw new Error("Sign in to save changes");
    await commitList((list) => {
      const have = new Set(list.contacts.map((c) => c.email));
      return {
        contacts: [...list.contacts, ...added.filter((c) => !have.has(c.email))],
        // Imported on purpose: off the deleted list, so the automatic add may keep them too.
        removed: clearRemoved(list.removed, organiser, added.map((c) => c.email)),
      };
    });
    wizardOpen = false;
  }

  async function handleDelete(email: string, alsoSuppress: boolean): Promise<void> {
    await auth.ensureOrganiserUnlock();
    const organiser = auth.parent;
    if (!organiser) throw new Error("Sign in to save changes");
    const deletedAt = new Date().toISOString();
    // Remembered as deleted, with or without the unsubscribe: the automatic add never brings them back.
    await commitList((list) => ({
      contacts: list.contacts.filter((c) => c.email !== email),
      removed: addRemoved(list.removed, organiser, email, deletedAt),
    }));
    if (alsoSuppress) {
      await suppressContacts([email]);
      await refreshConsentStates(contacts);
    }
  }

  /** Save one edited contact back into the list, keyed on the email (which the
   *  detail panel never lets you change, for exactly this reason). */
  async function handleSave(email: string, next: MarketingContact): Promise<void> {
    await commitList((list) => ({ ...list, contacts: list.contacts.map((c) => (c.email === email ? next : c)) }));
  }

  // A sync write (this screen's own, or one started on another organiser page) is
  // the newest list there is: show it. Never over a locked list.
  onMount(() =>
    onListWritten((payload, written) => {
      if (listLocked) return;
      contacts = payload.contacts;
      removed = normaliseRemoved(payload.removed);
      meta = written;
      void refreshConsentStates(payload.contacts);
    }),
  );

  const counts = $derived.by(() => {
    const out: Record<ContactConsentState, number> = {
      "opted-in": 0,
      "soft-opt-in": 0,
      imported: 0,
      unsubscribed: 0,
    };
    for (const c of contacts) out[contactConsentState(c.email, suppressedEmails, consentedEmails, softOptInEmails)]++;
    return out;
  });

  /**
   * The download is built in the browser from the list this screen has already
   * opened: no request, no extra unlock. Off while the screen does not know who
   * unsubscribed, because a copy that showed them as mailable is how an
   * unsubscriber gets emailed from another platform.
   */
  const canDownload = $derived(contacts.length > 0 && !listLocked && !consentUnknown && !saving);

  function downloadList(): void {
    if (!canDownload) return;
    const csv = buildContactsCsv(contacts, (email) =>
      contactConsentState(email, suppressedEmails, consentedEmails, softOptInEmails),
    );
    downloadCsv(contactsCsvFilename(new Date()), csv);
  }

  // Single-fire load once auth is ready (covers both mount-already-connected
  // and connect-after-mount without double-fetching).
  let loadStarted = false;
  $effect(() => {
    if (auth.ready && auth.isConnected && !loadStarted) {
      loadStarted = true;
      void load();
    }
  });

  // Unlocked - by the panel's tap or elsewhere this app open: open the list.
  // Locked again (the page sat hidden past the relock): hide the contacts.
  $effect(() => {
    if (auth.hasIdentitySeed && listLocked && !loading) void load();
  });
  $effect(() => {
    if (auth.kind === "passkey" && !auth.hasIdentitySeed && contacts.length > 0) {
      contacts = [];
      listLocked = true;
    }
  });
</script>

<div class="audience">
  <header class="head">
    <div>
      <h2>Audience</h2>
      <p class="sub">
        Your marketing list — encrypted to your identity, only you can read it.
        {#if meta && !listMissing}<span class="when">Saved {new Date(meta.updatedAt).toLocaleDateString()}.</span>{/if}
      </p>
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
  {:else if listLocked}
    <UnlockPanel subject="Contact details" action="Show contacts" />
  {:else if listMissing}
    {@const saved = new Date(listMissing.updatedAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}
    {@const list = `Your list of ${listMissing.count} ${listMissing.count === 1 ? "contact" : "contacts"}, last saved ${saved},`}
    <div class="empty invite">
      <h3>Your saved contacts can't be found</h3>
      <p class="muted">
        {#if listMissing.storage === "expired"}
          {list} was kept on storage that has expired, so it can't be brought back.
        {:else if listMissing.storage === "live"}
          {list} can't be reached right now. Try again in a few minutes.
        {:else}
          {list} can't be found in storage. If the storage it was kept on has expired, it can't be brought back.
        {/if}
      </p>
      <p class="muted">
        Start a new list to carry on - ticket buyers who said yes at checkout are added again
        automatically, and you can import the rest. Anyone who unsubscribed stays unsubscribed.
      </p>
      {#if startNewError}<p class="err">{startNewError}</p>{/if}
      <div class="actions center">
        {#if listMissing.storage === "live"}
          <button class="btn-primary" disabled={saving} onclick={() => void load()}>Try again</button>
          <button class="btn-ghost" disabled={saving} onclick={() => void startNewList()}>Start a new list</button>
        {:else}
          <button class="btn-primary" disabled={saving} onclick={() => void startNewList()}>Start a new list</button>
          <button class="btn-ghost" disabled={saving} onclick={() => void load()}>Try again</button>
        {/if}
      </div>
    </div>
  {:else}
    {#if listNotice}
      <p class="list-notice" role="status">{listNotice}</p>
    {/if}
    {#if contacts.length === 0 && !wizardOpen}
      <div class="empty invite">
        <span class="mark" aria-hidden="true"></span>
        <h3>Bring your people with you</h3>
        <p class="muted">
          Import the customer lists you've exported from Skiddle, Fatsoma, RA or any other
          platform. Ticket buyers who said yes at checkout are added for you. Contacts are
          encrypted before they're stored - and anyone who unsubscribes stays unsubscribed,
          even if you re-import the same file.
        </p>
        <div class="actions center">
          <button class="btn-primary" onclick={() => (wizardOpen = true)}>Import contacts</button>
          <!-- Deliberately offered BEFORE there is an audience. The test send
               takes one address the organiser types and skips the membership
               check entirely, so seeing the email is the step that should come
               before handing over other people's data — not after (#135). -->
          <button
            class="btn-ghost"
            class:active={panel === "compose"}
            onclick={() => (panel = panel === "compose" ? null : "compose")}
          >See what an email looks like</button>
        </div>
      </div>
    {:else}
      <ConsentLedger
        {counts}
        filter={consentFilter}
        onFilter={(next) => {
          consentFilter = next;
          // Filtering is only meaningful against the list, so open it — a
          // filter that changes nothing you can see reads as a broken button.
          if (next) panel = "contacts";
        }}
      />

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
          onclick={() => {
            panel = panel === "contacts" ? null : "contacts";
            // Closing the list drops the filter with it, so reopening never
            // starts on a hidden subset of the audience.
            if (panel !== "contacts") consentFilter = null;
          }}
        >Browse contacts</button>
      </div>

      {#if contacts.length > 0}
        <div class="export">
          <button class="btn-ghost" onclick={downloadList} disabled={!canDownload}>Download your list (CSV)</button>
          <p class="export-note">
            {#if consentUnknown}
              We couldn't check who unsubscribed, so the download is paused: a copy that showed them as
              mailable could get them emailed from somewhere else. Reload the page to try again.
            {:else}
              A copy of everyone on your list, to keep or take elsewhere. Anyone on it who unsubscribed
              is marked, so you don't email them by mistake. It holds personal details - store it safely.
            {/if}
          </p>
        </div>
      {/if}
    {/if}

    <AudienceSyncStatus />

    {#if wizardOpen}
      <CsvImportWizard
        existingEmails={new Set(contacts.map((c) => c.email))}
        busy={saving}
        onCommit={handleWizardCommit}
        onCancel={() => (wizardOpen = false)}
      />
    {/if}

    {#if panel === "contacts" && contacts.length > 0 && consentUnknown}
      <p class="consent-unknown">
        Couldn't check who said yes at checkout or unsubscribed, so the labels below may be wrong.
        Sending is unaffected — unsubscribes are always honoured when a broadcast goes out.
      </p>
    {/if}

    {#if panel === "contacts" && contacts.length > 0}
      <ContactSearch
        {contacts}
        {suppressedEmails}
        {consentedEmails}
        {softOptInEmails}
        filter={consentFilter}
        busy={saving}
        onSave={handleSave}
        onDelete={handleDelete}
      />
    {/if}

    <!-- No contact-count gate. The endpoint behind the test send says it plainly:
         "There is deliberately NO imported-list membership check: the point is
         previewing in an inbox that may not be in the audience." Requiring an
         audience to reach it inverted the one feature meant to work first. -->
    {#if panel === "compose"}
      <StripeVerifyGate
        bind:verified={stripeVerified}
        title="Verify Stripe to send broadcasts"
        sub="Marketing email sends on WoCo's shared reputation, so broadcasting needs a connected, verified Stripe account — it's free and verifies who you are. Adding contacts to your list needs the same verification; removing them never does."
      />
      {#if stripeVerified}
        <MarketingComposer {contacts} {suppressedEmails} {provenEmails} {softOptInEmails} initialEventId={announceEventId} />
      {/if}
    {/if}

    <!-- Custom sending domains are off until SES (FEATURES.organiserSendingDomains).
         The panel is kept, not deleted: the flag is one line from turning it back on. -->
    {#if FEATURES.organiserSendingDomains && stripeVerified !== false}
      <SendingDomainPanel />
    {/if}
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
  .list-notice {
    margin: 0;
    padding: 0.75rem 1rem;
    border: 1px solid var(--border);
    border-left: 3px solid var(--warning);
    border-radius: var(--radius-md);
    font-size: 0.8125rem;
    line-height: 1.5;
    color: var(--text);
  }
  .consent-unknown {
    margin: 0 0 0.75rem;
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }
  .err { color: var(--error); font-size: 0.875rem; }

  .when { color: var(--text-dim); }

  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .actions.center { justify-content: center; }

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
  .btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-ghost:disabled:hover { border-color: var(--border); color: var(--text-secondary); }

  .export {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.375rem;
  }

  .export-note {
    margin: 0;
    max-width: 52ch;
    font-size: 0.75rem;
    line-height: 1.5;
    color: var(--text-muted);
  }
</style>
