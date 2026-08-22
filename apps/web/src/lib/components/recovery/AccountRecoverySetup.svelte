<script lang="ts">
  /**
   * "Protect your account" — passkey account recovery setup (docs/PASSKEY_RECOVERY_PLAN §11).
   * Crypto is hidden: the user picks a backup method, confirms the wallet, and we do the rest.
   *
   * State machine:
   *   intro → choosing → connecting → confirming → working → done
   *   intro → confirm-remove → removing → removed
   *   any phase → error → (retry → choosing)
   *
   * HONESTY RULES THIS SCREEN IS BOUND BY (#148, #164):
   *  - "protected" is read from the CHAIN, not the server's presence hint, and an
   *    unreadable chain says so rather than claiming the account is unprotected.
   *  - the backup LIST is the WoCo hook's on-chain guardian set, never the
   *    manifest (which only labels rows); an unreadable set renders as "couldn't
   *    load", never as an empty list.
   *  - a per-backup "Remove" exists ONLY behind the WoCo hook and reports success
   *    only off a verified on-chain revoke. On a legacy (ZeroDev-hook) route there
   *    is no per-guardian revoke, and the next "add" REPLACES the route — the user
   *    is told so at the confirm step, before anything is sent.
   *  - removed backups stay removed: every route installed since #164 points at
   *    the WoCo hook, so re-adding no longer resurrects old guardians.
   */
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { connectBackupWallet, connectWeb3AuthBackup, connectPasskeyBackup, type BackupWallet } from "../../wallet/backup-signer.js";
  import { isPasskeySupported } from "../../auth/passkey-account.js";
  import { readBackupProtection } from "../../auth/backup-management.js";
  import { fetchRecoveryByGuardian } from "../../api/recovery.js";
  import { guardianConfigForBackup } from "../../auth/guardian-config.js";

  type Phase =
    | "intro" | "choosing" | "connecting" | "confirming" | "working" | "done"
    | "confirm-remove" | "removing" | "removed" | "error";
  let phase = $state<Phase>("intro");
  let connectingMethod = $state<"email" | "wallet" | "passkey" | null>(null);
  let pendingBackup = $state<BackupWallet | null>(null);
  let backupAddress = $state<string | null>(null);
  // Soft warn: this wallet already guards a DIFFERENT account (independence nudge).
  let bindWarning = $state<string | null>(null);
  // Info (not error): this wallet already guards THIS account — nothing to change.
  let alreadyGuarding = $state(false);
  let errorMsg = $state("");
  // Which flow failed — the retry must go back to that flow, not drop a user who
  // tried to REMOVE their backups into the "choose a backup method" screen.
  let errorFrom = $state<"add" | "remove">("add");

  let checking = $state(false);
  let checkDone = $state(false);
  // Tri-state (#138 discipline): `null` means "couldn't tell", which must render as
  // uncertainty, never as "you have no backup". Only a chain read sets it to false.
  let isProtected = $state<boolean | null>(null);
  let protectionSource = $state<"chain" | "hint" | "none">("none");
  // Whether the hint/manifest cleanup after a removal also succeeded — cosmetic,
  // reported so the panel never silently disagrees with itself.
  let removeBookkeepingOk = $state(true);
  // Which hook gates this account's route (#164). `woco` = the on-chain list below
  // is real and each entry can be removed on its own; `legacy` = the ZeroDev
  // append-only hook — no list, no per-backup remove, and the next add REPLACES the
  // route (the user is told before confirming); `other` = a hook this app did not
  // install — only "remove all" is offered.
  let hookKind = $state<"woco" | "legacy" | "none" | "other" | null>(null);
  // The guardian set as the WoCo hook holds it — chain truth, NOT the manifest.
  // `null` = not read (legacy/other/none route); `"unknown"` = the chain could not
  // be read, which renders as "couldn't load", never as an empty list (#138).
  let onChainGuardians = $state<string[] | "unknown" | null>(null);
  // Manifest memory-jogs (method/provider/date) keyed by lowercased guardian address
  // — labels only; the row exists because the CHAIN lists it.
  let backupLabels = $state<Record<string, { method: string; providerLabel?: string; addedAt: number }>>({});
  // Per-row remove state (inline; the screen stays on the protected intro).
  let revokingGuardian = $state<string | null>(null);
  let revokeError = $state("");
  let revokeBookkeepingNote = $state("");

  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const addrDisplay = (a: string) => `${a.slice(0, 10)}…${a.slice(-8)}`;
  const signedIn = $derived(auth.isConnected);
  // Kernel-backed kinds can install guardian recovery: passkey (rotated credential
  // can't re-derive its keys) and web3auth (raw key is an external-config dependency
  // that can be repointed). Self-custody kinds (web3/local/coinbase) recover from
  // their own wallet, so they see the "already covered" message instead.
  const canProtect = $derived(auth.kind === "passkey" || auth.kind === "web3auth");

  // ── Backup-method recommendation ────────────────────────────────────────
  // WHICH factors we offer, and which is best, is fully determined by HOW the
  // user signs in — so the guidance can be exact, never a guess. The load-bearing
  // rule is INDEPENDENCE from the primary login:
  //   - same KEY is impossible: chooseAndConnect() hard-blocks any guardian whose
  //     address is auth.parent (Kernel) or auth.podAddress (the primary's raw
  //     deterministic EOA — PRF-EOA for passkey, Web3Auth EOA for web3auth).
  //   - same PROVIDER-fate is a soft warn added at connect time (1b).
  // A web3auth user signs in BY email/social, so their backup email/social must be
  // a DIFFERENT provider (the copy says so; the same-key block enforces the worst case).
  type Method = "email" | "wallet" | "passkey";
  interface MethodOption {
    id: Method;
    name: string;
    hint: string;
    recommended?: boolean;
  }
  // Only offer a passkey where the device can actually make one — never recommend
  // an impossible option (create still fails loudly if PRF is missing).
  const passkeySupported = isPasskeySupported();
  const methodOptions = $derived<MethodOption[]>(
    auth.kind === "web3auth"
      ? [
          // Primary IS email/social, so a passkey is the strongest independent factor
          // for a phone-first user; the email tile must be a DIFFERENT provider.
          ...(passkeySupported
            ? [{ id: "passkey" as const, name: "Passkey", recommended: true,
                 hint: "Create a recovery passkey on your phone. Best if it syncs (iCloud, Google)." }]
            : []),
          { id: "email", name: "Different email or social", recommended: !passkeySupported,
            hint: "Sign in with a different provider than the one you use to log in." },
          { id: "wallet", name: "Crypto wallet",
            hint: "Use MetaMask or any browser wallet." },
        ]
      : [
          // Passkey primary — email/social is the most portable, independent backup.
          { id: "email", name: "Email or social", recommended: true,
            hint: "Sign in by email or social to create a recovery key. Works on any device." },
          { id: "wallet", name: "Crypto wallet",
            hint: "Use MetaMask or any browser wallet." },
          ...(passkeySupported
            ? [{ id: "passkey" as const, name: "Another passkey",
                 hint: "Add a second passkey as backup. Best if it syncs across your devices." }]
            : []),
        ],
  );

  $effect(() => {
    if (checkDone || checking) return;
    if (!signedIn || !canProtect) return;
    const kernel = auth.parent;
    if (!kernel) return;
    checking = true;
    (async () => {
      try {
        // Chain first — the server's presence hint is forgeable and goes stale the
        // moment a user removes a backup, so it is only a fallback here.
        await refreshProtection(kernel);
      } catch { /* hiccup — stays null, i.e. "couldn't tell" */ } finally {
        checking = false;
        checkDone = true;
      }
      // Separate + non-blocking: labels are a memory-jog from the manifest; a
      // manifest hiccup must not stall the panel or hide the on-chain list.
      loadBackupLabels();
    })();
  });

  async function refreshProtection(kernel: string) {
    const p = await readBackupProtection(kernel);
    isProtected = p.isProtected;
    protectionSource = p.source;
    hookKind = p.routeState === "installed" ? (p.hookKind ?? "other") : p.routeState === "absent" ? "none" : null;
    onChainGuardians =
      p.onChainGuardians === undefined ? null
      : p.onChainGuardians.state === "read" ? p.onChainGuardians.guardians
      : "unknown";
  }

  function loadBackupLabels() {
    auth.getBackupInventory()
      .then((r) => {
        if (r.status !== "known") return;
        const next: typeof backupLabels = {};
        for (const b of r.backups) {
          next[b.guardianAddress.toLowerCase()] = { method: b.method, providerLabel: b.providerLabel, addedAt: b.addedAt };
        }
        backupLabels = next;
      })
      .catch(() => { /* labels only */ });
  }

  function backupLabel(guardian: string): string {
    const l = backupLabels[guardian.toLowerCase()];
    if (!l) return "Backup";
    const method = l.method === "passkey" ? "Passkey" : l.method === "wallet" ? "Wallet" : "Email / social";
    return l.providerLabel && l.providerLabel !== l.method ? `${method} · ${l.providerLabel}` : method;
  }

  function signIn() {
    loginRequest.request({ context: "attendee" });
  }

  function startChoosing() {
    pendingBackup = null;
    bindWarning = null;
    alreadyGuarding = false;
    errorMsg = "";
    errorFrom = "add";
    phase = "choosing";
  }

  async function chooseAndConnect(method: Method) {
    phase = "connecting";
    connectingMethod = method;
    errorMsg = "";
    alreadyGuarding = false;
    bindWarning = null;
    try {
      const backup = method === "email"
        ? await connectWeb3AuthBackup()
        : method === "passkey"
        ? await connectPasskeyBackup("create")
        : await connectBackupWallet();

      // Hard block: the backup must not be one of this account's own keys (fate-sharing).
      const backupLc = backup.address.toLowerCase();
      const ownKeys = [auth.parent, auth.podAddress].filter(Boolean).map(a => a!.toLowerCase());
      if (ownKeys.includes(backupLc)) {
        throw new Error("Pick a different wallet — your backup can't be a key that already controls this account.");
      }

      // Look up by the DERIVED guardian address (what setupAccountRecovery writes to the index).
      // Independence rule (plan §12.3): "already your backup" = info; cross-account = soft warn.
      try {
        // Pure derivation (no RPC) of the same helper-built config setup will pin (#161).
        const { guardianAddressFor } = await import("../../auth/guardian-address.js");
        const guardianAddr = guardianAddressFor(guardianConfigForBackup(backup.address));
        const existing = await fetchRecoveryByGuardian(guardianAddr).catch(() => null);
        if (existing && auth.parent) {
          if (existing.kernelAddress.toLowerCase() === auth.parent.toLowerCase()) {
            alreadyGuarding = true;
          } else {
            bindWarning = "This wallet already guards another account. Using it here means one backup protects both — fine, but worth knowing.";
          }
        }
      } catch { /* guardian-address lookup is a hint — non-fatal */ }

      pendingBackup = backup;
      phase = "confirming";
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Couldn't connect — please try again";
      phase = "error";
    }
  }

  async function confirmAndInstall() {
    if (!pendingBackup) return;
    phase = "working";
    errorMsg = "";
    try {
      await auth.setupAccountRecovery({
        ...pendingBackup,
        // Record HOW this backup was added in the user's encrypted-to-self manifest
        // (non-PII memory-jog). connectingMethod is set at connect and persists here.
        meta: { method: connectingMethod ?? "wallet", providerLabel: pendingBackup.providerLabel },
      });
      backupAddress = pendingBackup.address;
      isProtected = true; // the install succeeded, so the route is on-chain
      protectionSource = "chain";
      phase = "done";
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Something went wrong — please try again";
      phase = "error";
    }
  }

  function startRemove() {
    errorMsg = "";
    errorFrom = "remove";
    phase = "confirm-remove";
  }

  /**
   * Uninstall the recovery route — the all-at-once revoke (per-backup removal is
   * `revokeOne`, WoCo-hook routes only). `removeAccountBackups` throws unless the
   * chain proves the route is gone, so reaching "removed" is never an assumption: an
   * unverifiable removal surfaces as an error, not a green tick.
   */
  async function confirmRemove() {
    phase = "removing";
    errorMsg = "";
    try {
      // We only offer this button off a confirmed-protected state, so an account
      // that reads back as undeployed is a contradiction the chain layer must
      // refuse rather than resolve into a cheerful "nothing to remove".
      const outcome = await auth.removeAccountBackups({ expectInstalled: isProtected === true });
      removeBookkeepingOk = outcome.hintCleared && outcome.manifestCleared;
      isProtected = false;
      protectionSource = "chain";
      hookKind = "none";
      onChainGuardians = null;
      backupAddress = null;
      phase = "removed";
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Couldn't remove your backups — please try again";
      phase = "error";
    }
  }

  /**
   * Remove ONE backup (#164) — only offered when the route points at the WoCo hook.
   * `revokeAccountBackup` throws unless the chain proves the guardian is out of the
   * set, so the row disappears only off a verified revoke; the list is then RE-READ
   * from the chain rather than edited locally.
   */
  async function revokeOne(guardian: string) {
    if (revokingGuardian) return;
    revokingGuardian = guardian;
    revokeError = "";
    revokeBookkeepingNote = "";
    try {
      const outcome = await auth.revokeAccountBackup(guardian);
      if (!outcome.hintCleared || !outcome.manifestMarked) {
        revokeBookkeepingNote =
          "Removed on-chain. We couldn't update every record of it — your backup list may briefly still show it.";
      }
      const kernel = auth.parent;
      if (kernel) {
        try { await refreshProtection(kernel); } catch { /* the verified revoke stands; list re-reads next open */ }
      }
      loadBackupLabels();
    } catch (e) {
      revokeError = e instanceof Error ? e.message : "Couldn't remove that backup — please try again";
    } finally {
      revokingGuardian = null;
    }
  }
</script>

<section class="wrap">
  <div class="panel" class:panel--done={phase === "done"}>
    <div class="crest" aria-hidden="true">
      <svg viewBox="0 0 64 72" fill="none">
        <path class="crest-shield" d="M32 3 L59 14 V36 C59 53 47 64 32 69 C17 64 5 53 5 36 V14 Z" />
        {#if phase === "done"}
          <path class="crest-check" d="M21 36 L29 45 L44 26" />
        {:else}
          <path class="crest-key" d="M32 24 a7 7 0 1 0 0.01 0 M32 31 V48 M32 42 H39" />
        {/if}
      </svg>
      <span class="crest-pulse" class:on={phase === "working" || phase === "connecting"}></span>
    </div>

    {#if phase === "done"}
      <p class="kicker kicker--hi">You're protected</p>
      <h1>Backup added</h1>
      <p class="lede">
        If you ever lose access to this login, your backup can restore your account —
        with your events and history intact.
      </p>
      <div class="backup-chip">
        <span class="dot"></span>
        Backup key&ensp;<code>{backupAddress ? short(backupAddress) : ""}</code>
      </div>
      <p class="footnote">Keep that backup safe. It's the key to getting back in.</p>

    {:else if !signedIn}
      <p class="kicker">Account safety</p>
      <h1>Protect your account</h1>
      <p class="lede">Sign in first, then add a backup so you can get back in if you ever lose this device.</p>
      <button class="btn btn--primary btn--lg cta" onclick={signIn}>Sign in</button>

    {:else if !canProtect}
      <p class="kicker">Account safety</p>
      <h1>You're already covered</h1>
      <p class="lede">
        This account signs in with your own wallet, so you can always restore it from
        there. Account backups are for passkey and email sign-ins.
      </p>

    {:else if checking}
      <p class="kicker">Account safety</p>
      <h1>Protect your account</h1>
      <p class="hint-sm" aria-live="polite">Checking your account…</p>

    {:else if phase === "removed"}
      <p class="kicker">Account safety</p>
      <h1>Backups removed</h1>
      <p class="lede">
        Account recovery is off. No backup can restore this account any more.
      </p>
      <p class="security-note" role="note">
        If you lose this login now, there is <strong>no way back in</strong>. Add a backup
        again when you can.
      </p>
      <p class="footnote">
        Backups you removed stay removed. A backup you add later is the only one that can
        restore this account — none of the old ones come back with it.
      </p>
      {#if !removeBookkeepingOk}
        <p class="footnote">
          We couldn't update your backup list everywhere — it may still show backups that
          can no longer restore this account.
        </p>
      {/if}
      <button class="btn btn--ghost cta" onclick={startChoosing}>Add a backup</button>

    {:else if phase === "confirm-remove"}
      <p class="kicker">Account safety</p>
      <h1>Remove all backups?</h1>
      <p class="lede">
        This turns account recovery off completely — no backup will be able to restore
        this account.
      </p>
      <ul class="reasons">
        <li><span class="tick tick--warn">!</span> Every backup on this account stops working at once</li>
        <li><span class="tick tick--warn">!</span> If you lose this login afterwards, nothing can get you back in</li>
        {#if hookKind === "woco"}
          <li>
            <span class="tick">✓</span>
            To drop just one backup, use <strong>Remove</strong> next to it instead — the others keep working
          </li>
        {/if}
        <li>
          <span class="tick tick--warn">!</span>
          A backup you've already added keeps the keys it was given: it can still read your
          ticket history and publish as your account. Removing can't take those back
        </li>
      </ul>
      <button class="btn btn--danger btn--lg cta" onclick={confirmRemove}>Remove all backups</button>
      <button class="linkish cta-link" onclick={() => (phase = "intro")}>Keep my backups</button>

    {:else if phase === "removing"}
      <p class="kicker">Account safety</p>
      <h1>Removing your backups</h1>
      <p class="lede">
        Approve anything your device asks for. We then check on-chain that it actually
        worked before telling you it's done.
      </p>
      <p class="hint-sm" aria-live="polite"><span class="spinner"></span> Working…</p>

    {:else if phase === "intro" && isProtected === true}
      <p class="kicker kicker--hi">Account safety</p>
      <h1>Backup on record</h1>
      <p class="lede">
        You've set up a backup for this account. If you lose access to this login, your
        backup can restore it — with your events and history intact.
      </p>
      <div class="backup-chip">
        <span class="dot"></span>
        Backup configured
      </div>
      {#if protectionSource === "hint"}
        <p class="soft-warn" role="note">
          We couldn't reach the network to confirm this on-chain, so this is from our
          records rather than from the account itself.
        </p>
      {/if}
      {#if hookKind === "woco"}
        <!-- The list is CHAIN truth (the hook's guardian set); the manifest only labels it. -->
        {#if onChainGuardians === "unknown"}
          <p class="soft-warn" role="note">
            Couldn't load this account's backups from the network just now — reopen this screen
            in a moment. Nothing has changed.
          </p>
        {:else if Array.isArray(onChainGuardians)}
          <ul class="backup-list" aria-label="Backups on this account">
            {#each onChainGuardians as g (g)}
              <li class="backup-row">
                <span class="backup-row-main">
                  <span class="backup-row-title">{backupLabel(g)}</span>
                  <code class="backup-row-addr">{short(g)}</code>
                </span>
                <button
                  class="linkish danger-link backup-row-remove"
                  disabled={revokingGuardian !== null}
                  onclick={() => revokeOne(g)}
                >
                  {revokingGuardian === g ? "Removing…" : "Remove"}
                </button>
              </li>
            {/each}
          </ul>
          {#if onChainGuardians.length === 0}
            <p class="soft-warn" role="note">
              The recovery route is on but lists no backup — nothing can restore this account
              right now. Add one below.
            </p>
          {/if}
        {/if}
        {#if revokeError}
          <p class="error" role="alert">{revokeError}</p>
        {/if}
        {#if revokeBookkeepingNote}
          <p class="footnote">{revokeBookkeepingNote}</p>
        {/if}
        <p class="footnote">
          Each backup can restore your account on its own. Removing one takes effect on-chain
          and the others keep working.
        </p>
      {:else if hookKind === "legacy"}
        <p class="security-note" role="note">
          This account's recovery still runs on the previous contract, which can't remove a
          single backup. <strong>Adding a backup moves it to the new one</strong> — only the
          backup you add then will be able to restore this account; add the others again
          afterwards if you still want them.
        </p>
      {:else if hookKind === "other"}
        <p class="security-note" role="note">
          This account's recovery route uses a contract this app doesn't know. You can remove
          all backups and set up again; nothing else will be changed from here.
        </p>
      {/if}
      <p class="footnote">The only way to be fully sure is to run a recovery on another device.</p>
      {#if hookKind !== "other"}
        <button class="btn btn--ghost cta" onclick={startChoosing}>Add another backup</button>
      {/if}
      <button class="linkish cta-link danger-link" onclick={startRemove}>Remove all backups</button>

    {:else if phase === "intro"}
      <p class="kicker">Account safety</p>
      <h1>Protect your account</h1>
      <p class="lede">
        Add a backup so you can always get back into your account — on any device or sign-in.
      </p>
      <ul class="reasons">
        <li><span class="tick">✓</span> Recover on any phone or laptop</li>
        <li><span class="tick">✓</span> Your events and history come with you</li>
        <li><span class="tick">✓</span> Only a backup you choose — never WoCo, never anyone else</li>
      </ul>
      {#if isProtected === null && checkDone}
        <p class="soft-warn" role="note">
          We couldn't check whether this account already has a backup. Adding one is safe
          either way — it adds to any you already have.
        </p>
      {/if}
      <button class="btn btn--primary btn--lg cta" onclick={startChoosing}>Add a backup</button>
      <p class="footnote">Takes a few seconds — you'll confirm on this device.</p>

    {:else if phase === "choosing"}
      <p class="kicker">Account safety</p>
      <h1>Choose a backup method</h1>
      <p class="lede">
        {auth.kind === "web3auth"
          ? "Pick a second, independent way back in — separate from the email you sign in with."
          : "Pick how you'll get back in. Email or social is easiest for most people."}
      </p>

      <div class="method-grid">
        {#each methodOptions as m (m.id)}
          <button class="method-card" onclick={() => chooseAndConnect(m.id)}>
            <span class="method-icon">
              {#if m.id === "email"}
                <svg viewBox="0 0 20 16" fill="none" stroke="currentColor" stroke-width="1.7"
                     stroke-linecap="round" stroke-linejoin="round" width="22" height="18" aria-hidden="true">
                  <rect x="1" y="1" width="18" height="14" rx="2.5"/>
                  <polyline points="1,2.5 10,9.5 19,2.5"/>
                </svg>
              {:else if m.id === "passkey"}
                <svg viewBox="0 0 22 18" fill="none" stroke="currentColor" stroke-width="1.7"
                     stroke-linecap="round" stroke-linejoin="round" width="22" height="18" aria-hidden="true">
                  <circle cx="7" cy="8" r="4.5"/>
                  <path d="M11.5 8 H21 M17.5 8 V12 M21 8 V11.5"/>
                </svg>
              {:else}
                <svg viewBox="0 0 22 18" fill="none" stroke="currentColor" stroke-width="1.7"
                     stroke-linecap="round" stroke-linejoin="round" width="22" height="18" aria-hidden="true">
                  <rect x="1" y="5" width="20" height="12" rx="2.5"/>
                  <path d="M6 5V3.5a2.5 2.5 0 015 0V5"/>
                  <circle cx="16" cy="11" r="1.8" fill="currentColor" stroke="none"/>
                </svg>
              {/if}
            </span>
            <strong class="method-name">{m.name}</strong>
            <span class="method-hint">{m.hint}</span>
            {#if m.recommended}
              <span class="method-badge">Recommended</span>
            {/if}
          </button>
        {/each}
      </div>

    {:else if phase === "connecting"}
      <p class="kicker">Account safety</p>
      <h1>
        {connectingMethod === "email"
          ? "Sign in with email"
          : connectingMethod === "passkey"
          ? "Create your recovery passkey"
          : "Connect your wallet"}
      </h1>
      <p class="lede">
        {connectingMethod === "email"
          ? "A sign-in window will open — log in with your email."
          : connectingMethod === "passkey"
          ? "Your device will ask you to create a passkey. Use one that syncs to your other devices."
          : "Approve the connection request in your wallet."}
      </p>
      <p class="hint-sm"><span class="spinner"></span> Connecting…</p>
      <button class="linkish" onclick={startChoosing}>Cancel</button>

    {:else if phase === "confirming"}
      <p class="kicker">Account safety</p>

      {#if alreadyGuarding}
        <h1>Already your backup</h1>
        <p class="lede">This wallet is already the backup for this account — nothing to change.</p>
        <div class="backup-chip">
          <span class="dot"></span>
          Backup key&ensp;<code>{pendingBackup ? short(pendingBackup.address) : ""}</code>
        </div>
        <button class="btn btn--ghost cta" onclick={startChoosing}>Use a different backup</button>
      {:else}
        <h1>Confirm your backup</h1>
        <p class="lede">This becomes your recovery key — make sure it's a wallet you control.</p>

        <div class="addr-box">
          <span class="addr-label">Backup wallet</span>
          <code class="addr-val">{pendingBackup ? addrDisplay(pendingBackup.address) : ""}</code>
        </div>

        {#if connectingMethod === "passkey"}
          <p class="soft-warn" role="note">
            Make sure this passkey syncs to your other devices (iCloud Keychain or Google) —
            a device-only passkey can't restore your account if you lose this device.
          </p>
        {/if}

        {#if bindWarning}
          <p class="soft-warn" role="note">{bindWarning}</p>
        {/if}

        {#if isProtected === true && hookKind === "legacy"}
          <!-- The install REPLACES a legacy route (decideAddPath): the old hook's guardians
               become unreachable. This is the consent point — the store does not ask again. -->
          <p class="security-note" role="note">
            This account's recovery still runs on the previous contract. Setting this backup
            <strong>moves recovery to the new contract, and the backups you added before will
            stop working</strong>. Add them again afterwards if you still want them.
          </p>
        {:else if isProtected === true}
          <p class="soft-warn" role="note">
            You already have a backup. This <strong>adds</strong> another — the existing ones
            keep working, and each can be removed on its own later.
          </p>
        {/if}

        <p class="security-note">
          This wallet will be able to restore your account. Only ever approve a signature
          request here when <strong>you</strong> started a WoCo recovery yourself — never
          because of a link, email, or message telling you to sign something.
        </p>

        <button class="btn btn--primary btn--lg cta" onclick={confirmAndInstall}>
          Set as my backup
        </button>
        <p class="footnote">You'll confirm on this device, then sign once in your backup.</p>
        <button class="linkish cta-link" onclick={startChoosing}>Try a different method</button>
      {/if}

    {:else if phase === "working"}
      <p class="kicker">Account safety</p>
      <h1>{isProtected === true ? "Adding another backup" : "Setting up your backup"}</h1>
      <p class="lede">Confirm each prompt as it appears, then sign once in your backup wallet.</p>
      <p class="hint-sm" aria-live="polite"><span class="spinner"></span> Working…</p>

    {:else if phase === "error"}
      <p class="kicker">Account safety</p>
      <h1>{errorFrom === "remove" ? "Remove all backups" : "Protect your account"}</h1>
      <p class="error" role="alert">{errorMsg}</p>
      {#if errorFrom === "remove"}
        <button class="btn btn--danger btn--lg cta" onclick={startRemove}>Try again</button>
        <button class="linkish cta-link" onclick={() => (phase = "intro")}>Back</button>
      {:else}
        <button class="btn btn--primary btn--lg cta" onclick={startChoosing}>Try again</button>
      {/if}
    {/if}
  </div>
</section>

<style>
  .wrap {
    min-height: 100%;
    display: grid;
    place-items: center;
    padding: clamp(1.5rem, 5vw, 4rem) 1.25rem;
  }

  .panel {
    position: relative;
    width: min(28rem, 100%);
    background:
      radial-gradient(120% 90% at 50% -10%, var(--accent-subtle), transparent 60%),
      var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 2.5rem 2rem 2rem;
    text-align: center;
    overflow: hidden;
    animation: rise 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  .panel::before {
    content: "";
    position: absolute;
    inset: 0 0 auto 0;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
    opacity: 0.5;
  }
  .panel--done { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }

  .crest {
    position: relative;
    width: 84px; height: 84px;
    margin: 0 auto 1.25rem;
    display: grid;
    place-items: center;
  }
  .crest svg { width: 64px; height: 72px; overflow: visible; }
  .crest-shield { fill: var(--accent-subtle); stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; }
  .crest-key { fill: none; stroke: var(--accent); stroke-width: 2.5; stroke-linecap: round; }
  .crest-check {
    fill: none; stroke: var(--accent); stroke-width: 3.5; stroke-linecap: round; stroke-linejoin: round;
    stroke-dasharray: 48; stroke-dashoffset: 48;
    animation: draw 0.5s 0.1s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
  }
  .crest-pulse {
    position: absolute; inset: 0; border-radius: 50%;
    border: 1px solid var(--accent); opacity: 0;
  }
  .crest-pulse.on { animation: pulse 1.4s ease-out infinite; }

  h1 {
    font-family: var(--font-display);
    font-size: 1.65rem;
    letter-spacing: -0.02em;
    margin: 0.25rem 0 0.6rem;
  }
  .kicker { justify-content: center; display: inline-flex; }
  .kicker--hi { color: var(--accent-text); }
  .lede {
    color: var(--text-secondary);
    line-height: 1.55;
    font-size: 0.97rem;
    margin: 0 auto 1.4rem;
    max-width: 24rem;
  }

  .reasons {
    list-style: none; margin: 0 0 1.5rem; padding: 0;
    display: grid; gap: 0.55rem; text-align: left;
  }
  .reasons li { display: flex; gap: 0.6rem; align-items: flex-start; font-size: 0.92rem; color: var(--text-secondary); }
  .tick {
    color: var(--accent-ink); background: var(--accent); border-radius: 50%;
    width: 1.1rem; height: 1.1rem; display: grid; place-items: center;
    font-size: 0.7rem; flex: none; margin-top: 0.1rem;
  }
  /* Same list shape, opposite meaning: the remove-confirm screen lists what you
     LOSE, so an acid-lime tick would read as reassurance. */
  .tick--warn { background: var(--error); color: var(--bg-surface); font-weight: 700; }

  /* ── Method chooser ────────────────────────────────────────────────── */
  .method-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.65rem;
    margin-bottom: 0.5rem;
    text-align: left;
  }
  .method-card {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    align-items: flex-start;
    padding: 1rem 0.9rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
    text-align: left;
  }
  .method-card:hover {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 6%, var(--bg-input));
  }
  .method-icon {
    color: var(--accent);
    margin-bottom: 0.1rem;
    display: flex;
  }
  .method-name {
    font-size: 0.92rem;
    font-weight: 600;
    color: var(--text);
    line-height: 1.2;
  }
  .method-hint {
    font-size: 0.78rem;
    color: var(--text-muted);
    line-height: 1.4;
  }
  .method-badge {
    display: inline-block;
    margin-top: 0.2rem;
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--accent-ink);
    background: var(--accent);
    border-radius: 2px;
    padding: 0.15rem 0.4rem;
  }

  /* ── Confirming address display ────────────────────────────────────── */
  .addr-box {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    background: var(--bg-input);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
    border-radius: var(--radius-md);
    padding: 0.75rem 1rem;
    margin: 0 0 1rem;
  }
  .addr-label { font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .addr-val { font-family: var(--font-mono); font-size: 0.85rem; color: var(--text); word-break: break-all; }

  .soft-warn {
    font-size: 0.82rem;
    color: var(--text-secondary);
    background: var(--bg-elevated);
    border: 1px solid var(--border-hover);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius-md);
    padding: 0.55rem 0.75rem;
    margin: 0 0 1rem;
    text-align: left;
    line-height: 1.45;
  }

  /* Anti-phishing note on the guardian-bind step — warning-toned, distinct from
     the informational .soft-warn so it reads as "stop and think", not chrome. */
  .security-note {
    font-size: 0.82rem;
    color: var(--text-secondary);
    background: var(--bg-elevated);
    border: 1px solid var(--border-hover);
    border-left: 3px solid var(--warning);
    border-radius: var(--radius-md);
    padding: 0.55rem 0.75rem;
    margin: 0 0 1rem;
    text-align: left;
    line-height: 1.45;
  }
  .security-note strong { color: var(--text); }

  /* ── Shared ─────────────────────────────────────────────────────────── */
  .cta { width: 100%; justify-content: center; gap: 0.5rem; white-space: nowrap; }
  .cta-link {
    display: block;
    margin-top: 0.75rem;
    font-size: 0.82rem;
    color: var(--text-muted);
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .cta-link:hover { color: var(--text-secondary); }
  .danger-link { color: var(--error); }
  .danger-link:hover { color: var(--error); opacity: 0.8; }

  /* Destructive primary — app.css has no danger button, and this is the only
     screen that permanently switches account recovery off. */
  .btn--danger {
    background: var(--error);
    color: var(--bg-surface);
    border: 1px solid var(--error);
  }
  .btn--danger:hover { opacity: 0.9; }
  .btn--danger:active { opacity: 0.8; }

  .backup-chip {
    display: inline-flex; align-items: center; gap: 0.5rem;
    font-size: 0.85rem; color: var(--text-secondary);
    background: var(--bg-input); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 0.5rem 0.8rem; margin: 0.4rem 0 1rem;
  }
  .backup-chip code { font-family: var(--font-mono); color: var(--text); }
  .backup-chip .dot {
    width: 0.5rem; height: 0.5rem; border-radius: 50%;
    background: var(--accent); box-shadow: 0 0 8px var(--accent);
  }

  .hint-sm {
    display: flex; align-items: center; justify-content: center;
    gap: 0.5rem; font-size: 0.88rem; color: var(--text-secondary);
    margin: 0.5rem 0 1rem;
  }

  .linkish {
    background: none; border: none; padding: 0; cursor: pointer;
    font-size: 0.82rem; color: var(--text-muted); text-decoration: underline;
    text-underline-offset: 2px; display: block; margin: 0.5rem auto 0;
  }
  .linkish:hover { color: var(--text-secondary); }

  .footnote { font-size: 0.8rem; color: var(--text-muted); margin: 0.75rem 0 0; }
  /* On-chain backup list (#164) — one row per guardian in the hook's set. */
  .backup-list {
    list-style: none;
    margin: 0.9rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    text-align: left;
  }
  .backup-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-input);
  }
  .backup-row-main { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
  .backup-row-title { font-size: 0.9rem; font-weight: 600; color: var(--text); }
  .backup-row-addr { font-family: var(--font-mono); font-size: 0.78rem; color: var(--text-muted); }
  .backup-row-remove { flex: none; font-size: 0.85rem; }
  .backup-row-remove:disabled { opacity: 0.55; cursor: default; }
  .error {
    color: var(--error); background: var(--error-subtle);
    border: 1px solid color-mix(in srgb, var(--error) 35%, transparent);
    border-radius: var(--radius-md);
    padding: 0.6rem 0.8rem; font-size: 0.88rem; margin: 0 0 1rem;
  }

  .spinner {
    display: inline-block; width: 0.9rem; height: 0.9rem; flex: none;
    border: 2px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-top-color: var(--accent); border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  @keyframes draw { to { stroke-dashoffset: 0; } }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse {
    0% { opacity: 0.5; transform: scale(0.7); }
    100% { opacity: 0; transform: scale(1.25); }
  }
  @media (prefers-reduced-motion: reduce) {
    .panel, .crest-check, .crest-pulse.on { animation: none; }
    .crest-check { stroke-dashoffset: 0; }
  }
</style>
