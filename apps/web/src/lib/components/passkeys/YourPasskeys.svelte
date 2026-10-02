<script lang="ts">
  import { StorageKeys, PASSKEY_PROVIDERS, credentialTagOf, type PasskeyProviderId } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { getKV } from "../../auth/storage/indexeddb.js";
  import { listDeviceGrants } from "../../api/device-grants.js";
  import {
    verifyDeviceGrantList,
    ownerFromOwnGrant,
    type VerifiedPasskey,
  } from "../../auth/device-grant-verify.js";
  import { readPasskeyMeta, type AddedPasskeyMeta } from "../../auth/passkey-meta.js";
  import { credentialIdBytes } from "../../auth/passkey-record.js";
  import LinkAnotherDevice from "./LinkAnotherDevice.svelte";

  /**
   * "Your passkeys" (#746 step 3): the main passkey and every passkey it added,
   * from the server's list checked in this browser. Never asks for a passkey on
   * page open - the list needs a session, and without one it waits for a tap.
   */

  let rows = $state<VerifiedPasskey[]>([]);
  let labels = $state<Record<string, AddedPasskeyMeta>>({});
  let mainProvider = $state<PasskeyProviderId | null>(null);
  let thisTag = $state<string | null>(null);
  let loading = $state(false);
  let loaded = $state(false);
  let loadError = $state<string | null>(null);

  let adding = $state<"closed" | "explain" | "creating" | "saving" | "linking">("closed");
  let addError = $state<string | null>(null);
  let addedNote = $state<string | null>(null);

  let linking = $state(false);

  let confirming = $state<string | null>(null);
  let removing = $state<string | null>(null);
  let removeError = $state<string | null>(null);

  const isPasskey = $derived(auth.kind === "passkey");
  const owner = $derived(auth.isAccountOwner);
  const active = $derived(rows.filter((r) => r.removedAt === null));
  const removed = $derived(rows.filter((r) => r.removedAt !== null));

  function providerName(id: PasskeyProviderId | null | undefined): string | null {
    if (!id || id === "other" || id === "unknown") return null;
    return PASSKEY_PROVIDERS[id].name;
  }

  function day(ms: number): string {
    return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  function label(r: VerifiedPasskey): string {
    const name = providerName(labels[r.credentialTag]?.provider);
    const when = day(r.issuedAt * 1000);
    return name ? `${name} - added ${when}` : `Added passkey - ${when}`;
  }

  async function load(): Promise<void> {
    if (!auth.parent || !auth.seedAddress) return;
    loading = true;
    loadError = null;
    try {
      const pinned = await getKV<{ credentialId?: string; provider?: PasskeyProviderId }>(StorageKeys.PASSKEY_CREDENTIAL);
      thisTag = pinned?.credentialId ? credentialTagOf(credentialIdBytes(pinned.credentialId)) : null;
      mainProvider = owner ? (pinned?.provider ?? null) : null;
      labels = await readPasskeyMeta(auth.parent);
      const res = await listDeviceGrants();
      if (!res.ok || !res.data) {
        loadError = res.error ?? "Couldn't load your passkeys - try again.";
        return;
      }
      const grants = res.data.grants;
      const expectedOwner = owner ? auth.seedAddress : ownerFromOwnGrant(grants, auth.seedAddress);
      rows = expectedOwner ? verifyDeviceGrantList(grants, { parent: auth.parent, owner: expectedOwner }) : [];
      loaded = true;
    } catch (e) {
      loadError = e instanceof Error ? e.message : "Couldn't load your passkeys - try again.";
    } finally {
      loading = false;
    }
  }

  // Once per visit, and only with a session already here: minting one is a passkey
  // prompt, and a page open is not the moment for one. NOT reactive on purpose - a
  // failed load must wait for the button, not retry against the server in a loop.
  let autoTried = false;
  $effect(() => {
    if (isPasskey && auth.hasSession && !autoTried) {
      autoTried = true;
      void load();
    }
  });

  async function add(): Promise<void> {
    if (adding !== "explain") return;
    addError = null;
    addedNote = null;
    // Busy from the tap: unlocking may show a passkey sheet before the first step.
    adding = "creating";
    try {
      const { provider } = await auth.addPasskeyOnThisDevice((step) => (adding = step));
      const name = providerName(provider);
      addedNote = name
        ? `Added. Sign in with it on any device where ${name} is signed in.`
        : "Added. Sign in with it wherever that password manager is signed in.";
      adding = "closed";
      loaded = false;
      await load();
    } catch (e) {
      addError =
        e instanceof Error && e.name === "PasskeyCeremonyCancelledError"
          ? "No passkey was added."
          : e instanceof Error
            ? e.message
            : "No passkey was added.";
      adding = "explain";
    }
  }

  async function remove(grantee: string): Promise<void> {
    removing = grantee;
    removeError = null;
    try {
      await auth.removePasskey(grantee);
      confirming = null;
      loaded = false;
      if (auth.isConnected) await load();
    } catch (e) {
      removeError = e instanceof Error ? e.message : "Couldn't remove it - try again.";
    } finally {
      removing = null;
    }
  }
</script>

<section class="passkeys">
  <header>
    <h2>Your passkeys</h2>
    <p class="intro">
      Each passkey opens this account. Keep one in a second password manager so losing one doesn't lock you out.
    </p>
  </header>

  {#if !auth.isConnected}
    <button class="btn btn--primary" onclick={() => loginRequest.request()}>Sign in</button>
  {:else if !isPasskey}
    <p class="muted">This account signs in another way. More than one passkey is for passkey accounts.</p>
  {:else}
    {#if !owner}
      <p class="note">You're signed in with an added passkey. To add or remove passkeys, sign in with your main passkey.</p>
    {/if}

    {#if !loaded}
      {#if loading}
        <p class="muted">Loading your passkeys…</p>
      {:else}
        {#if loadError}<p class="err">{loadError}</p>{/if}
        <button class="btn btn--ghost" onclick={load}>Show your passkeys</button>
      {/if}
    {:else}
      <ul class="rows">
        <li class="row">
          <div class="what">
            <span class="name">{providerName(mainProvider) ?? "Main passkey"}</span>
            <span class="chips">
              <span class="chip">Main</span>
              {#if owner}<span class="chip">This device</span>{/if}
            </span>
          </div>
        </li>
        {#each active as r (r.grantee)}
          {@const mine = thisTag !== null && r.credentialTag === thisTag}
          <li class="row">
            <div class="what">
              <span class="name">{label(r)}</span>
              {#if mine}<span class="chips"><span class="chip">This device</span></span>{/if}
            </div>
            {#if owner || mine}
              {#if confirming === r.grantee}
                <div class="confirm">
                  <p>
                    {mine
                      ? "Remove this passkey? It stops opening the account and you'll be signed out here."
                      : "Remove this passkey? It stops opening the account right away. Anything already on that device stays on it."}
                  </p>
                  <button class="btn btn--primary" onclick={() => remove(r.grantee)} disabled={removing !== null}>
                    {removing === r.grantee ? "Removing…" : "Remove"}
                  </button>
                  <button class="btn btn--ghost" onclick={() => (confirming = null)} disabled={removing !== null}>Keep it</button>
                </div>
              {:else}
                <button class="btn btn--ghost" onclick={() => (confirming = r.grantee)}>
                  {mine ? "Remove this passkey" : "Remove"}
                </button>
              {/if}
            {/if}
          </li>
        {/each}
        {#each removed as r (r.grantee)}
          <li class="row removed">
            <span class="name">{label(r)}</span>
            <span class="muted">Removed {day(r.removedAt ?? 0)}</span>
          </li>
        {/each}
      </ul>
      {#if removeError}<p class="err">{removeError}</p>{/if}

      {#if owner}
        {#if linking}
          <LinkAnotherDevice onlinked={() => { loaded = false; void load(); }} onclose={() => (linking = false)} />
        {:else if adding === "closed"}
          <button class="btn btn--primary" onclick={() => (linking = true)}>Link another device</button>
          <button class="btn btn--ghost" onclick={() => { adding = "explain"; addError = null; }}>
            Add a passkey on this device
          </button>
        {/if}
        {#if adding !== "closed" && !linking}
          <div class="add">
            <p>
              Pick a different password manager than the one holding your main passkey - another passkey in the same
              one adds nothing if you lose it.
            </p>
            {#if addError}<p class="err">{addError}</p>{/if}
            {#if adding === "explain"}
              <button class="btn btn--primary" onclick={add}>Continue</button>
              <button class="btn btn--ghost" onclick={() => (adding = "closed")}>Not now</button>
            {:else}
              <p class="muted">
                {adding === "creating" ? "Creating…" : adding === "saving" ? "Saving to your account…" : "Linking…"}
              </p>
            {/if}
          </div>
        {/if}
        {#if addedNote}<p class="ok">{addedNote}</p>{/if}
      {/if}
    {/if}
  {/if}
</section>

<style>
  .passkeys {
    display: grid;
    gap: 1rem;
    max-width: 40rem;
    margin: 0 auto;
    padding: 1.5rem 1rem;
  }
  h2 {
    margin: 0;
    font-family: var(--font-display);
  }
  .intro,
  .muted {
    margin: 0;
    color: var(--text-secondary);
  }
  .note {
    margin: 0;
    padding: 0.75rem 1rem;
    border: 1px solid var(--border-hover);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    color: var(--text);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }
  .row {
    display: grid;
    gap: 0.5rem;
    padding: 0.85rem 1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
  }
  .row.removed {
    opacity: 0.6;
  }
  .what {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    justify-content: space-between;
  }
  .name {
    color: var(--text);
  }
  .chips {
    display: flex;
    gap: 0.35rem;
  }
  .chip {
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-sm);
    background: var(--accent-subtle);
    color: var(--accent-text);
    font-size: 0.8rem;
  }
  .confirm,
  .add {
    display: grid;
    gap: 0.5rem;
    justify-items: start;
  }
  .confirm p,
  .add p {
    margin: 0;
    color: var(--text-secondary);
  }
  .err {
    margin: 0;
    color: var(--error);
  }
  .ok {
    margin: 0;
    color: var(--accent-text);
  }
</style>
