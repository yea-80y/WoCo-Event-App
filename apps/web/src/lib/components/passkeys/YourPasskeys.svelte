<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { unlocksWhen } from "../../attendee/gate/unlock-copy.js";
  import type { PasskeyRow } from "../../auth/your-passkeys-data.js";
  import type { PasskeyProviderId } from "@woco/shared";

  /**
   * "Your passkeys" (#746, every passkey a co-owner): the passkeys on the account,
   * all equal - each opens it and can do everything, adding and removing passkeys
   * included. Each row says where its passkey works when this device knows the
   * password manager, so a person can see a barrier coming (a Samsung Pass passkey
   * never reaches a laptop). Never asks for a passkey on page open.
   */

  let rows = $state<PasskeyRow[]>([]);
  let canAdd = $state(false);
  let loading = $state(false);
  let loaded = $state(false);
  let loadError = $state<string | null>(null);
  let names = $state<{ name: (id: PasskeyProviderId | null) => string | null; worksOn: (id: PasskeyProviderId | null) => string | null } | null>(null);

  let linking = $state(false);
  let adding = $state<"closed" | "explain" | "creating" | "saving" | "linking" | "done">("closed");
  let addError = $state<string | null>(null);
  let addedName = $state<string | null>(null);

  let confirming = $state<string | null>(null);
  let removing = $state<string | null>(null);
  let removeError = $state<string | null>(null);

  const loadLinkAnotherDevice = () => import("./LinkAnotherDevice.svelte");

  const isPasskey = $derived(auth.kind === "passkey");
  const linkedOnly = $derived(!auth.isAccountOwner);
  const busy = $derived(linking || (adding !== "closed" && adding !== "explain" && adding !== "done") || removing !== null);
  const current = $derived(rows.find((r) => r.signedInWith) ?? null);

  function day(ms: number): string {
    return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  function title(r: PasskeyRow): string {
    return names?.name(r.provider) ?? (r.addedAt === null ? "Your first passkey" : "Passkey");
  }

  async function load(): Promise<void> {
    if (!auth.parent || !auth.seedAddress) return;
    loading = true;
    loadError = null;
    try {
      const data = await import("../../auth/your-passkeys-data.js");
      names = { name: data.providerName, worksOn: data.providerWorksOn };
      const res = await data.loadPasskeyRows(auth.parent, auth.seedAddress);
      rows = res.rows;
      canAdd = res.canAdd;
      loaded = true;
    } catch (e) {
      loadError = e instanceof Error ? e.message : "Couldn't read your passkeys - try again.";
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
    // Busy from the tap: the first thing is a passkey sheet.
    adding = "creating";
    try {
      const { provider } = await auth.addPasskeyOnThisDevice((step) => (adding = step));
      const data = await import("../../auth/your-passkeys-data.js");
      addedName = data.providerName(provider);
      adding = "done";
      loaded = false;
      await load();
    } catch (e) {
      addError =
        e instanceof Error && (e.name === "PasskeyCeremonyCancelledError" || e.name === "NotAllowedError")
          ? "No passkey was added."
          : e instanceof Error
            ? e.message
            : "No passkey was added.";
      adding = "explain";
    }
  }

  async function remove(r: PasskeyRow): Promise<void> {
    removing = r.key;
    removeError = null;
    try {
      await auth.removePasskey(r.key);
      confirming = null;
      if (adding === "done") adding = "closed";
      loaded = false;
      if (auth.isConnected) await load();
    } catch (e) {
      removeError =
        e instanceof Error && (e.name === "PasskeyCeremonyCancelledError" || e.name === "NotAllowedError")
          ? "Nothing was removed."
          : e instanceof Error
            ? e.message
            : "Couldn't remove it - try again.";
    } finally {
      removing = null;
    }
  }
</script>

<section class="passkeys" aria-labelledby="passkeys-title">
  <header>
    <h2 id="passkeys-title">Your passkeys</h2>
    <p class="lede">Each one opens your account and can do everything. Add one for every device you use.</p>
  </header>

  {#if !auth.isConnected}
    <button class="btn btn--primary" onclick={() => loginRequest.request()}>Sign in</button>
  {:else if !isPasskey}
    <p class="muted">This account signs in another way. Passkeys are for passkey accounts.</p>
  {:else}
    {#if linkedOnly}
      <p class="note">
        This device was linked before every passkey could do everything. To add or remove passkeys here, remove it and
        add it again from one of your other passkeys.
      </p>
    {/if}

    {#if !loaded}
      {#if loading}
        <p class="muted">Reading your passkeys…</p>
      {:else}
        {#if loadError}<p class="err" role="alert">{loadError}</p>{/if}
        <button class="btn btn--ghost" onclick={load}>Show your passkeys</button>
      {/if}
    {:else}
      <ul class="list">
        {#each rows as r (r.key)}
          {@const where = names?.worksOn(r.provider) ?? null}
          <li class="row" class:open={confirming === r.key}>
            <div class="line">
              <div class="who">
                <span class="name">{title(r)}</span>
                {#if where}<span class="where">{where}</span>{/if}
                <span class="meta">
                  {#if r.addedAt !== null}<span>Added {day(r.addedAt)}</span>{/if}
                  {#if r.signedInWith}<span class="tag">Signed in here</span>
                  {:else if r.onThisDevice}<span class="tag">On this device</span>{/if}
                </span>
              </div>
              {#if !linkedOnly && rows.length > 1 && confirming !== r.key}
                <button
                  class="remove"
                  onclick={() => { confirming = r.key; removeError = null; }}
                  disabled={busy}
                  aria-label={`Remove ${title(r)}`}
                >Remove</button>
              {/if}
            </div>
            {#if confirming === r.key}
              <div class="confirm">
                <p>
                  {r.signedInWith
                    ? "Remove the passkey you're signed in with? It stops opening your account and you'll be signed out here."
                    : `Remove ${title(r)}? It stops opening your account straight away. Anything already on that device stays on it.`}
                </p>
                <div class="pair">
                  <button class="btn btn--danger" onclick={() => remove(r)} disabled={removing !== null}>
                    {removing === r.key ? "Removing…" : "Remove"}
                  </button>
                  <button class="btn btn--ghost" onclick={() => (confirming = null)} disabled={removing !== null}>Keep it</button>
                </div>
                <p class="hint">Your device will ask you to confirm it's you.</p>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
      {#if removeError}<p class="err" role="alert">{removeError}</p>{/if}

      {#if linking}
        {#await loadLinkAnotherDevice() then { default: LinkAnotherDevice }}
          <LinkAnotherDevice onlinked={() => { loaded = false; void load(); }} onclose={() => (linking = false)} />
        {:catch}
          <p class="err">Couldn't open this - check your connection and try again.</p>
        {/await}
      {:else if adding === "done"}
        <div class="panel" role="status">
          <p class="panel-title">Added to {addedName ?? "the new password manager"}</p>
          <p>
            Both passkeys now open your account.
            {current ? `Moving away from ${title(current)}? Remove it now - or keep both.` : ""}
          </p>
          <div class="pair">
            <button class="btn btn--primary" onclick={() => (adding = "closed")}>Keep both</button>
            {#if current}
              <button class="btn btn--ghost" onclick={() => { confirming = current.key; adding = "closed"; }}>
                Remove {title(current)}
              </button>
            {/if}
          </div>
        </div>
      {:else if adding !== "closed"}
        <div class="panel">
          <p class="panel-title">Add a password manager</p>
          <p>
            First confirm it's you. Then pick where to save the new passkey - Google Password Manager, 1Password,
            Bitwarden or any other. Your current passkeys keep working.
          </p>
          {#if addError}<p class="err" role="alert">{addError}</p>{/if}
          {#if adding === "explain"}
            <div class="pair">
              <button class="btn btn--primary" onclick={add}>Continue</button>
              <button class="btn btn--ghost" onclick={() => (adding = "closed")}>Not now</button>
            </div>
          {:else}
            <p class="muted">
              {adding === "creating" ? "Waiting for your password manager…" : adding === "saving" ? "Saving it to your account…" : "Adding it to your account…"}
            </p>
          {/if}
        </div>
      {:else if !linkedOnly}
        {#if !canAdd}
          <p class="muted">{unlocksWhen("Adding devices and password managers", true)}</p>
        {:else}
          <div class="actions">
            <div class="action">
              <button class="btn btn--primary" onclick={() => (linking = true)} disabled={busy}>Add another device</button>
              <p class="hint">A laptop or another phone that can't use these passkeys.</p>
            </div>
            <div class="action">
              <button class="btn btn--ghost" onclick={() => { adding = "explain"; addError = null; }} disabled={busy}>
                Add a password manager here
              </button>
              <p class="hint">Switching password manager? Add the new one, then remove the old one.</p>
            </div>
          </div>
          <p class="warn">Only add your own devices - never someone else's, staff included. Each one has full control of your account.</p>
        {/if}
      {/if}
    {/if}
  {/if}
</section>

<style>
  .passkeys {
    display: grid;
    gap: 1.25rem;
    max-width: 38rem;
    margin: 0 auto;
    padding: 1.5rem 1rem 2.5rem;
  }
  header {
    display: grid;
    gap: 0.4rem;
  }
  h2 {
    margin: 0;
    font-family: var(--font-display);
    font-weight: 500;
    font-size: 1.75rem;
    letter-spacing: -0.01em;
  }
  p {
    margin: 0;
  }
  .lede {
    color: var(--text-secondary);
    max-width: 34rem;
  }
  .muted,
  .hint {
    color: var(--text-muted);
    font-size: 0.875rem;
  }
  .note {
    padding: 0.75rem 1rem;
    border: 1px solid var(--border-hover);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }
  .row {
    display: grid;
    gap: 0.75rem;
    padding: 0.9rem 1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
  }
  .row.open {
    border-color: var(--border-hover);
  }
  .line {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .who {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
  }
  .name {
    color: var(--text);
    font-weight: 500;
  }
  .where {
    color: var(--text-secondary);
    font-size: 0.925rem;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .tag {
    padding: 0.05rem 0.45rem;
    border-radius: var(--radius-sm);
    background: var(--accent-subtle);
    color: var(--accent-text);
    font-size: 0.8rem;
  }
  .remove {
    flex: none;
    min-height: 2.75rem;
    padding: 0 0.25rem;
    border: 0;
    background: none;
    color: var(--accent-text);
    font: inherit;
    font-size: 0.925rem;
    cursor: pointer;
  }
  .remove:disabled {
    color: var(--text-muted);
    cursor: default;
  }
  .confirm,
  .panel {
    display: grid;
    gap: 0.6rem;
  }
  .confirm p:first-child,
  .panel p {
    color: var(--text-secondary);
  }
  .panel {
    padding: 1rem;
    border: 1px solid var(--border-hover);
    border-radius: var(--radius-md);
  }
  .panel .panel-title {
    color: var(--text);
    font-weight: 500;
  }
  .pair {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .actions {
    display: grid;
    gap: 1rem;
  }
  .action {
    display: grid;
    gap: 0.35rem;
    justify-items: start;
  }
  .warn {
    color: var(--text-muted);
    font-size: 0.875rem;
    padding-top: 0.25rem;
    border-top: 1px solid var(--border);
  }
  .err {
    color: var(--error);
  }
  .btn--danger {
    background: var(--error);
    color: var(--accent-ink);
    border: 1px solid var(--error);
  }
</style>
