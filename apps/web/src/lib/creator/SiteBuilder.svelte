<script lang="ts">
  import type { ClaimMode, OrderField, PaymentConfig } from "@woco/shared";
  import { auth } from "../auth/auth-store.svelte.js";
  import { loginRequest } from "../auth/login-request.svelte.js";
  import { authPost } from "../api/client.js";
  import { router } from "../router/router.svelte.js";
  import EventEditor from "./events/EventEditor.svelte";
  import PublishButton from "./events/PublishButton.svelte";
  import ImportUrlPanel, { type ImportPreview, type ImportTier } from "./events/ImportUrlPanel.svelte";
  import GatewayPicker from "./builder/GatewayPicker.svelte";
  import AdvancedSetup from "./builder/AdvancedSetup.svelte";
  import SiteSelector from "./builder/SiteSelector.svelte";
  import EventDomainPicker, { type EventDomainIntent } from "./builder/EventDomainPicker.svelte";
  import { addSiteEvent } from "../api/sites.js";
  import { claimSubEnsLabel, claimSubEnsViaPermit, setSubEnsContenthash, stampEventSubEns } from "../api/sub-ens.js";
  import { registerDomain, verifyDomainDns, type DomainEntry } from "../api/domains.js";

  const apiUrl = import.meta.env.VITE_API_URL ?? "";
  const advanced = $derived(router.params.advanced === "1");

  // ── Wizard step ───────────────────────────────────────────────────────────────
  let step = $state(1);

  // Step 1 — event creation
  type SeriesDraft = {
    seriesId: string;
    name: string;
    description: string;
    totalSupply: number;
    approvalRequired?: boolean;
    wave?: string;
    saleStart?: string;
    saleEnd?: string;
    payment?: PaymentConfig;
  };

  let eventTitle = $state("");
  let eventTagline = $state("");
  let eventDescription = $state("");
  let eventStartDate = $state("");
  let eventEndDate = $state("");
  let eventLocation = $state("");
  let eventImageDataUrl = $state<string | null>(null);
  let eventSeries = $state<SeriesDraft[]>([]);
  let eventOrderFields = $state<OrderField[]>([]);
  let claimMode = $state<ClaimMode>("email");
  let collectEmail = $state(true);
  let collectInfo = $state(false);
  let cryptoRecipientMissing = $state(false);
  let stripeVerificationMissing = $state(false);
  let createdEventId = $state<string | null>(null);
  let importedTiers = $state<ImportTier[] | null>(null);

  function applyImport(p: ImportPreview) {
    if (p.name)        eventTitle       = p.name;
    if (p.tagline)     eventTagline     = p.tagline;
    if (p.description) eventDescription = p.description;
    if (p.startDate)   eventStartDate   = p.startDate;
    if (p.location)    eventLocation    = p.location;
    if (p.tiers && p.tiers.length > 0) importedTiers = p.tiers;
  }

  function onEventPublished(eventId: string) {
    createdEventId = eventId;
    step = 2;
  }

  // Step 2 — deploy targets
  let gatewayUrl = $state("https://gateway.etherna.io");
  let paraApiKey = $state("");
  let listOnWoco = $state(false);
  let selectedSiteIds = $state<string[]>([]);
  let siteAddErrors = $state<Record<string, string>>({});

  // Sub-ENS for this event — intent captured here, acted on after deploy (needs contentHash)
  let domainIntent = $state<EventDomainIntent>({ mode: "none" });
  let subEnsPhase = $state<"idle" | "pending" | "done" | "error">("idle");
  let subEnsLabel = $state("");
  let subEnsError = $state<string | null>(null);

  // Step 3 — live + domain (deploy state)
  let deploying = $state(false);
  let deployError = $state<string | null>(null);
  let deployResult = $state<{ contentHash: string; feedManifestHash: string } | null>(null);

  let listingOnWoco = $state(false);
  let wocoListError = $state<string | null>(null);
  let wocoListed = $state(false);
  let addingToSites = $state(false);

  let customDomainInput = $state("");
  let domainRegistering = $state(false);
  let domainVerifying = $state(false);
  let domainEntry = $state<DomainEntry | null>(null);
  let domainError = $state<string | null>(null);

  async function handleRegisterDomain() {
    if (!createdEventId || !deployResult || domainRegistering) return;
    const hostname = customDomainInput.trim().toLowerCase();
    if (!hostname) { domainError = "Enter a hostname"; return; }
    domainError = null;
    domainRegistering = true;
    try {
      domainEntry = await registerDomain(
        hostname,
        createdEventId,
        deployResult.contentHash,
        deployResult.feedManifestHash,
      );
    } catch (err) {
      domainError = err instanceof Error ? err.message : "Registration failed";
    } finally {
      domainRegistering = false;
    }
  }

  async function handleVerifyDomain() {
    if (!domainEntry || domainVerifying) return;
    domainError = null;
    domainVerifying = true;
    try {
      const result = await verifyDomainDns(domainEntry.hostname);
      if (result.verified) {
        domainEntry = { ...domainEntry, verified: true, verifiedAt: new Date().toISOString() };
      } else {
        domainError = result.error || "DNS not yet configured";
      }
    } catch (err) {
      domainError = err instanceof Error ? err.message : "Verification failed";
    } finally {
      domainVerifying = false;
    }
  }

  const eventSiteUrl = $derived(
    deployResult
      ? `${gatewayUrl.trim()}/bzz/${deployResult.contentHash}/`
      : ""
  );
  const dashboardUrl = $derived(eventSiteUrl ? `${eventSiteUrl}#/dashboard` : "");
  const ensHash = $derived(deployResult?.feedManifestHash ? `bzz://${deployResult.feedManifestHash}` : "");

  async function deployToSwarm(): Promise<boolean> {
    if (!createdEventId) return false;
    try {
      const json = await authPost<{ contentHash: string; feedManifestHash: string }>(
        "/api/site/deploy",
        {
          eventId: createdEventId,
          gatewayUrl: gatewayUrl.trim(),
          apiUrl,
          ...(paraApiKey.trim() ? { paraApiKey: paraApiKey.trim() } : {}),
        },
      );
      if (json.ok && json.data) {
        deployResult = json.data;
        return true;
      }
      deployError = json.error || "Deploy failed";
      return false;
    } catch (e) {
      deployError = e instanceof Error ? e.message : "Deploy failed";
      return false;
    }
  }

  async function createWocoListing() {
    if (!createdEventId) return;
    listingOnWoco = true;
    wocoListError = null;
    try {
      const result = await authPost<{ eventId: string }>(
        `/api/events/${createdEventId}/list`,
        { sourceApiUrl: apiUrl },
      );
      if (result.ok) {
        wocoListed = true;
      } else {
        wocoListError = (result as { error?: string }).error || "WoCo listing failed";
      }
    } catch (e) {
      wocoListError = e instanceof Error ? e.message : "WoCo listing failed";
    } finally {
      listingOnWoco = false;
    }
  }

  // Route the chosen sub-ENS at the freshly deployed event page. Runs after deploy
  // because it needs the contentHash. "new" mints (gasless permit for passkey logins,
  // sponsor mint otherwise) with the contenthash set in the same tx; "existing"
  // repoints an owned label via the ownership-checked set-contenthash endpoint.
  async function runSubEnsTask(contentHash: string) {
    const intent = domainIntent;
    if (intent.mode === "none") return;
    if (intent.mode === "new" && !intent.label) {
      subEnsPhase = "error";
      subEnsError = "Enter and confirm an available name in step 2 before deploying.";
      return;
    }

    subEnsPhase = "pending";
    subEnsError = null;
    subEnsLabel = intent.label;
    try {
      if (intent.mode === "new") {
        const res = auth.kind === "passkey"
          ? await claimSubEnsViaPermit({
              label: intent.label,
              kernelAddress: await auth.ensureWocoSessionKey(),
              swarmHash: contentHash,
              description: intent.description,
            })
          : await claimSubEnsLabel({
              label: intent.label,
              swarmHash: contentHash,
              description: intent.description,
            });
        if (!res.ok) { subEnsPhase = "error"; subEnsError = res.error ?? "Could not claim the name"; return; }
      } else {
        const res = await setSubEnsContenthash(intent.label, contentHash);
        if (!res.ok) { subEnsPhase = "error"; subEnsError = res.error ?? "Could not update the name"; return; }
      }
      // Display hint on the event feed (event pages show the name + social row).
      // Non-fatal: chain ownership is authoritative; a missed stamp just hides the badge.
      if (createdEventId) {
        stampEventSubEns(intent.label, createdEventId).catch((err) =>
          console.warn("[sub-ens] stamp-event failed (non-fatal):", err),
        );
      }
      subEnsPhase = "done";
    } catch (e) {
      subEnsPhase = "error";
      subEnsError = e instanceof Error ? e.message : "Sub-ENS update failed";
    }
  }

  // Background post-deploy work. The deployed site is live the moment
  // /api/site/deploy returns; site-event additions and WoCo directory listing
  // are additive — both endpoints are idempotent on the server (set-add /
  // no-op-if-listed). Running them inline blocked step → 3 for minutes when
  // the global directory had grown to multiple paged feed writes.
  async function runPostDeployTasks(targetSiteIds: string[]) {
    if (createdEventId && targetSiteIds.length > 0) {
      addingToSites = true;
      const next: Record<string, string> = {};
      try {
        const siteResults = await Promise.allSettled(
          targetSiteIds.map(id => addSiteEvent(id, createdEventId!)),
        );
        siteResults.forEach((r, i) => {
          const id = targetSiteIds[i];
          if (r.status === "rejected") {
            next[id] = (r.reason as Error)?.message ?? "Failed";
          } else if (r.status === "fulfilled") {
            const v = r.value as { ok?: boolean; error?: string };
            if (!v?.ok) next[id] = v?.error ?? "Failed";
          }
        });
      } finally {
        siteAddErrors = next;
        addingToSites = false;
      }
    }
    if (listOnWoco && !wocoListed) await createWocoListing();
  }

  async function handleDeploy() {
    deploying = true;
    deployError = null;
    deployResult = null;
    try {
      const ok = await deployToSwarm();
      if (!ok) return;

      // Advance the wizard immediately — site is live. Background tasks
      // surface their status via step-3 UI (addingToSites, siteAddErrors,
      // listingOnWoco, wocoListError, wocoListed, subEnsPhase).
      siteAddErrors = {};
      step = 3;
      void runPostDeployTasks([...selectedSiteIds]);
      if (deployResult) void runSubEnsTask(deployResult.contentHash);
    } catch (e) {
      deployError = e instanceof Error ? e.message : "Unexpected error during deploy";
    } finally {
      deploying = false;
    }
  }

  function retrySiteAdditions() {
    const failedIds = Object.keys(siteAddErrors);
    if (failedIds.length === 0) return;
    void runPostDeployTasks(failedIds);
  }

  function retrySubEns() {
    if (deployResult) void runSubEnsTask(deployResult.contentHash);
  }

  const subEnsName = $derived(subEnsLabel ? `${subEnsLabel}.woco.eth` : "");

  function copyText(text: string) { navigator.clipboard.writeText(text); }
</script>

<!-- ── Wizard shell ──────────────────────────────────────────────────────────── -->
<div class="wizard">

  <!-- Progress bar (3 steps) -->
  <div class="progress-bar">
    {#each [1,2,3] as n}
      <div class="progress-step" class:done={step > n} class:active={step === n} class:future={step < n}>
        <div class="progress-dot">{step > n ? "✓" : n}</div>
        <span class="progress-label">
          {n === 1 ? "Event" : n === 2 ? "Deploy" : "Live"}
        </span>
      </div>
      {#if n < 3}
        <div class="progress-line" class:done={step > n}></div>
      {/if}
    {/each}
  </div>

  <!-- ── Step 1: Event creation ────────────────────────────────────────────── -->
  {#if step === 1}
    <div class="step-content">
      <h2>Step 1 — Create your event</h2>
      <p class="step-intro">
        Fill in your event details. Everything is signed with your identity and
        stored on Swarm.
      </p>

      {#if !auth.isConnected}
        <div class="auth-prompt">
          <p>Sign in to create the event.</p>
          <button class="btn-primary" onclick={() => loginRequest.request()}>Sign in</button>
        </div>
      {:else}
        <div class="event-form">
          <div class="field-group">
            <label class="field-label" for="gw-picker">Gateway</label>
            <GatewayPicker bind:value={gatewayUrl} />
            <p class="field-hint">
              The Swarm gateway that will host and serve your deployed event site.
            </p>
          </div>

          <ImportUrlPanel onapply={applyImport} />

          <EventEditor
            bind:title={eventTitle}
            bind:tagline={eventTagline}
            bind:description={eventDescription}
            bind:startDate={eventStartDate}
            bind:endDate={eventEndDate}
            bind:location={eventLocation}
            bind:imageDataUrl={eventImageDataUrl}
            bind:series={eventSeries}
            bind:orderFields={eventOrderFields}
            bind:claimMode
            bind:collectEmail
            bind:collectInfo
            bind:cryptoRecipientMissing
            bind:stripeVerificationMissing
            bind:importedTiers
          />

          <PublishButton
            title={eventTitle}
            tagline={eventTagline}
            description={eventDescription}
            startDate={eventStartDate}
            endDate={eventEndDate}
            location={eventLocation}
            imageDataUrl={eventImageDataUrl}
            series={eventSeries}
            orderFields={collectInfo ? eventOrderFields : undefined}
            {claimMode}
            {apiUrl}
            skipAutoList
            label="Create event →"
            disabled={cryptoRecipientMissing || stripeVerificationMissing}
            disabledReason={cryptoRecipientMissing
              ? "Connect a wallet for crypto payouts above, or disable crypto on all tiers."
              : stripeVerificationMissing
                ? "Verify your Stripe account above, or turn off card payments, to publish."
                : undefined}
            onpublished={onEventPublished}
          />
        </div>
      {/if}
    </div>

  <!-- ── Step 2: Deploy targets ────────────────────────────────────────────── -->
  {:else if step === 2}
    <div class="step-content">
      <h2>Step 2 — Deploy</h2>
      <p class="step-intro">
        Choose your deploy targets and push your event site to Swarm in one click.
      </p>

      {#if createdEventId}
        <div class="success-banner">
          Event created ✓ &nbsp;<code>{createdEventId}</code>
        </div>
      {/if}

      <div class="list-woco-card">
        <label class="checkbox-option list-woco-check">
          <input type="checkbox" bind:checked={listOnWoco} />
          <div>
            <strong>List this event on WoCo</strong>
            <p class="note">
              Appears in WoCo's public directory at
              <a href="https://woco.eth.limo" target="_blank" rel="noopener">woco.eth.limo</a>.
            </p>
          </div>
        </label>
      </div>

      <div class="field-group">
        <SiteSelector bind:selectedSiteIds />
        {#if Object.keys(siteAddErrors).length > 0}
          {#each Object.entries(siteAddErrors) as [siteId, err]}
            <p class="site-add-error">Could not add to site <code>{siteId}</code>: {err}</p>
          {/each}
        {/if}
      </div>

      <EventDomainPicker bind:intent={domainIntent} />

      <details class="advanced-panel">
        <summary>Advanced</summary>
        <div class="advanced-panel-body">
          <div class="field-group">
            <label class="field-label" for="para-key">Para API key <span class="optional">optional</span></label>
            <input
              id="para-key"
              class="input"
              type="text"
              bind:value={paraApiKey}
              placeholder="Leave blank to use WoCo's shared beta key"
            />
            <p class="field-hint">
              Enables email-based wallet login for attendees. Get a key at
              <a href="https://developer.getpara.com" target="_blank" rel="noopener">developer.getpara.com</a>.
            </p>
          </div>
        </div>
      </details>

      {#if deployError}
        <div class="create-error">
          <strong>Deploy failed</strong>
          <p>{deployError}</p>
        </div>
      {/if}

      {#if deploying}
        <div class="progress-status">
          <div class="spinner"></div>
          <span>Building and uploading to Swarm… this takes 20–60 seconds.</span>
        </div>
      {/if}

      <div class="nav-row">
        <button class="btn-ghost" onclick={() => step = 1}>&larr; Back</button>
        <button
          class="btn-primary deploy-btn"
          disabled={deploying || !createdEventId}
          onclick={handleDeploy}
        >
          {deploying ? "Deploying…" : "Deploy to Swarm →"}
        </button>
      </div>
    </div>

  <!-- ── Step 3: Live ───────────────────────────────────────────────────────── -->
  {:else if step === 3}
    <div class="step-content">
      <h2>Step 3 — Live</h2>

      <div class="deploy-done-banner">
        &#9989; Site deployed to Swarm
      </div>

      <!-- Event site URL -->
      <div class="output-section">
        <div class="output-section-header">
          <span class="output-section-title">Event site</span>
          <a class="btn-primary output-launch-btn" href={eventSiteUrl} target="_blank" rel="noopener">
            Launch &#8599;
          </a>
        </div>
        <div class="output-url-row">
          <code class="output-url">{eventSiteUrl}</code>
          <button class="btn-ghost copy-btn" onclick={() => copyText(eventSiteUrl)}>Copy</button>
        </div>
      </div>

      <!-- Dashboard URL -->
      <div class="output-section">
        <div class="output-section-header">
          <span class="output-section-title">Organiser dashboard</span>
        </div>
        <div class="output-url-row">
          <code class="output-url">{dashboardUrl}</code>
          <button class="btn-ghost copy-btn" onclick={() => copyText(dashboardUrl)}>Copy</button>
        </div>
        <p class="output-hint">Sign in with your wallet to view orders and manage approvals. Bookmark this.</p>
      </div>

      <!-- ENS -->
      <div class="output-section">
        <div class="output-section-header">
          <span class="output-section-title">ENS content hash</span>
        </div>
        {#if deployResult?.feedManifestHash}
          <div class="output-url-row">
            <code class="output-url">{ensHash}</code>
            <button class="btn-ghost copy-btn" onclick={() => copyText(ensHash)}>Copy</button>
          </div>
          <p class="output-hint">
            Feed manifest — set as your ENS content record at
            <a href="https://app.ens.domains" target="_blank" rel="noopener">app.ens.domains</a>.
            Stays stable across redeploys.
          </p>
        {:else if deployResult}
          <div class="output-url-row">
            <code class="output-url">bzz://{deployResult.contentHash}</code>
            <button class="btn-ghost copy-btn" onclick={() => copyText(`bzz://${deployResult!.contentHash}`)}>Copy</button>
          </div>
        {/if}
      </div>

      <!-- Sub-ENS (.woco.eth) result -->
      {#if subEnsPhase !== "idle"}
        <div class="output-section subens-section" class:subens-done={subEnsPhase === "done"}>
          <div class="output-section-header">
            <span class="output-section-title">Web3 address</span>
          </div>
          {#if subEnsPhase === "pending"}
            <div class="progress-status">
              <div class="spinner"></div>
              <span>{domainIntent.mode === "new" ? "Registering" : "Repointing"} <code>{subEnsName}</code> on Arbitrum…</span>
            </div>
          {:else if subEnsPhase === "done"}
            <div class="subens-claimed">
              <span class="subens-name">{subEnsName}</span>
              <span class="subens-arrow">→ this event</span>
              <span class="subens-soon" title="Goes live once woco.eth's mainnet ENS resolver points to the Arbitrum registry">
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><circle cx="5.5" cy="5.5" r="4.2" stroke="currentColor" stroke-width="1.2"/><path d="M5.5 3.4V5.5l1.5 .9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                Live soon
              </span>
            </div>
            <p class="output-hint">Registered on Arbitrum — view the record on Arbiscan. The web address activates once woco.eth's resolver points to the L2 registry.</p>
          {:else if subEnsPhase === "error"}
            <div class="create-error" style="margin: 0;">{subEnsError}</div>
            {#if !(domainIntent.mode === "new" && !domainIntent.label)}
              <button class="btn-primary" style="margin-top: 0.75rem;" onclick={retrySubEns}>Retry</button>
            {/if}
          {/if}
        </div>
      {/if}

      <!-- Custom domain -->
      <div class="output-section">
        <div class="output-section-header">
          <span class="output-section-title">Custom domain</span>
        </div>

        {#if domainEntry?.verified}
          <div class="domain-verified-banner">
            Your site is live at <strong>{domainEntry.hostname}</strong>
          </div>
          <div class="output-url-row" style="margin-top: 0.5rem;">
            <a class="btn-primary output-launch-btn" href="https://{domainEntry.hostname}" target="_blank" rel="noopener">
              Visit site &#8599;
            </a>
          </div>

        {:else if domainEntry}
          <p class="domain-instruction">Add this DNS record to <strong>{domainEntry.hostname}</strong>:</p>
          <div class="dns-record">
            <div class="dns-record-row">
              <span class="dns-label">Type</span><code class="dns-value">CNAME</code>
            </div>
            <div class="dns-record-row">
              <span class="dns-label">Name</span><code class="dns-value">{domainEntry.hostname.split('.')[0]}</code>
            </div>
            <div class="dns-record-row">
              <span class="dns-label">Target</span><code class="dns-value">{domainEntry.cnameTarget || "sites.woco-net.com"}</code>
            </div>
          </div>
          {#if domainError}<p class="domain-error">{domainError}</p>{/if}
          <button class="btn-primary" style="margin-top: 0.75rem;" onclick={handleVerifyDomain} disabled={domainVerifying}>
            {domainVerifying ? "Checking DNS…" : "Verify domain"}
          </button>

        {:else}
          <p class="output-hint">Point your own domain at this event site.</p>
          <div class="domain-input-row">
            <input type="text" class="domain-input" placeholder="events.mycompany.com"
              bind:value={customDomainInput}
              onkeydown={(e) => e.key === "Enter" && handleRegisterDomain()} />
            <button class="btn-primary" onclick={handleRegisterDomain} disabled={domainRegistering || !customDomainInput.trim()}>
              {domainRegistering ? "Registering…" : "Add domain"}
            </button>
          </div>
          {#if domainError}<p class="domain-error">{domainError}</p>{/if}
        {/if}
      </div>

      <!-- Site additions (background; spinner while pending, retry on partial failure) -->
      {#if selectedSiteIds.length > 0 && (addingToSites || Object.keys(siteAddErrors).length > 0)}
        <div class="woco-listing-section">
          {#if addingToSites}
            <div class="progress-status">
              <div class="spinner"></div>
              <span>Adding to {Object.keys(siteAddErrors).length > 0 ? Object.keys(siteAddErrors).length : selectedSiteIds.length} of your sites…</span>
            </div>
          {:else if Object.keys(siteAddErrors).length > 0}
            {#each Object.entries(siteAddErrors) as [siteId, err]}
              <p class="site-add-error">Could not add to site <code>{siteId}</code>: {err}</p>
            {/each}
            <button class="btn-primary" style="margin-top: 0.75rem;" onclick={retrySiteAdditions} disabled={addingToSites}>
              Retry site additions
            </button>
          {/if}
        </div>
      {/if}

      <!-- WoCo listing (shown only if opted in and still pending or errored) -->
      {#if listOnWoco && (!wocoListed || wocoListError)}
        <div class="woco-listing-section">
          {#if wocoListed}
            <div class="woco-listed-banner">&#127881; Listed on WoCo!</div>
          {:else if wocoListError}
            <div class="create-error" style="margin: 0;">{wocoListError}</div>
            <button class="btn-primary" style="margin-top: 0.75rem;" onclick={createWocoListing} disabled={listingOnWoco}>
              Retry WoCo listing
            </button>
          {:else if listingOnWoco}
            <div class="progress-status"><div class="spinner"></div><span>Adding to WoCo directory…</span></div>
          {/if}
        </div>
      {/if}

      <!-- Raw hashes -->
      {#if deployResult}
        <details class="hash-details">
          <summary>Raw hashes</summary>
          <div class="hash-row">
            <span class="hash-label">Content hash</span>
            <code class="hash-val">{deployResult.contentHash}</code>
            <button class="btn-ghost copy-btn" onclick={() => copyText(deployResult!.contentHash)}>Copy</button>
          </div>
          {#if deployResult.feedManifestHash}
            <div class="hash-row">
              <span class="hash-label">Feed manifest</span>
              <code class="hash-val">{deployResult.feedManifestHash}</code>
              <button class="btn-ghost copy-btn" onclick={() => copyText(deployResult!.feedManifestHash)}>Copy</button>
            </div>
          {/if}
        </details>
      {/if}

      <div class="nav-row" style="margin-top: 1rem;">
        <span></span>
        <button class="btn-ghost" onclick={() => { step = 2; deployResult = null; }}>
          &larr; Change config &amp; redeploy
        </button>
      </div>
    </div>
  {/if}
</div>

<!-- Advanced setup panel shown via ?advanced=1 -->
{#if advanced}
  <AdvancedSetup {gatewayUrl} />
{/if}

<style>
  .wizard {
    max-width: 680px;
    margin: 0 auto;
  }

  /* ── Progress bar ─────────────────────────────────────────────────────────── */
  .progress-bar {
    display: flex;
    align-items: center;
    margin-bottom: 2.5rem;
    gap: 0;
  }

  .progress-step {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .progress-dot {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    font-weight: 700;
    transition: all var(--transition);
  }

  .progress-step.done .progress-dot { background: var(--success); color: var(--accent-ink); }
  .progress-step.active .progress-dot {
    background: var(--accent);
    color: var(--accent-ink);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
  }
  .progress-step.future .progress-dot { background: var(--bg-elevated); color: var(--text-muted); border: 1px solid var(--border); }

  .progress-label {
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }

  .progress-step.done .progress-label,
  .progress-step.active .progress-label { color: var(--text-secondary); }
  .progress-step.future .progress-label { color: var(--text-muted); }

  .progress-line {
    flex: 1;
    height: 2px;
    background: var(--border);
    margin-bottom: 1.25rem;
    transition: background var(--transition);
  }
  .progress-line.done { background: var(--success); }

  /* ── Step content ─────────────────────────────────────────────────────────── */
  .step-content { display: flex; flex-direction: column; gap: 1.5rem; }

  h2 { color: var(--text); font-size: 1.375rem; font-weight: 700; margin: 0; letter-spacing: -0.01em; }

  .step-intro { color: var(--text-secondary); font-size: 0.9375rem; line-height: 1.6; margin: 0; }

  /* ── Auth prompt ──────────────────────────────────────────────────────────── */
  .auth-prompt {
    text-align: center; padding: 2.5rem;
    border: 1px dashed var(--border); border-radius: var(--radius-md); color: var(--text-muted);
  }
  .auth-prompt p { margin: 0 0 1rem; }

  .event-form { display: flex; flex-direction: column; gap: 1.125rem; }

  /* ── Success banner ───────────────────────────────────────────────────────── */
  .success-banner {
    padding: 0.75rem 1rem; border: 1px solid var(--success);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--success) 8%, transparent);
    color: var(--success); font-size: 0.875rem;
  }
  .success-banner code { font-family: monospace; font-size: 0.8rem; }

  /* ── Form fields ─────────────────────────────────────────────────────────── */
  .field-group { display: flex; flex-direction: column; gap: 0.375rem; }
  .field-label {
    font-size: 0.875rem; font-weight: 600; color: var(--text);
    display: flex; align-items: center; gap: 0.375rem;
  }
  .optional { font-weight: 400; color: var(--text-muted); font-size: 0.8rem; }
  .input {
    width: 100%; padding: 0.625rem 0.875rem;
    background: var(--bg-input, var(--bg-surface)); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text); font-size: 0.9375rem;
    transition: border-color var(--transition); font-family: inherit;
  }
  .input:focus { outline: none; border-color: var(--accent); }
  .field-hint { font-size: 0.8125rem; color: var(--text-muted); margin: 0; line-height: 1.5; }
  .field-hint a { color: var(--accent-text); }

  .site-add-error { margin: 0; font-size: 0.8125rem; color: var(--error); }
  .site-add-error code { font-family: var(--font-mono); font-size: 0.75rem; }

  /* ── List on WoCo card ───────────────────────────────────────────────────── */
  .list-woco-card {
    border: 1px solid var(--border); border-radius: var(--radius-md);
    padding: 1rem 1.125rem; background: var(--bg-surface);
  }
  .list-woco-check { align-items: flex-start; }
  .list-woco-check strong { display: block; font-size: 0.9375rem; font-weight: 600; color: var(--text); margin-bottom: 0.25rem; }
  .note { font-size: 0.8125rem; color: var(--text-muted); line-height: 1.5; margin: 0; }
  .note a { color: var(--accent-text); }
  .checkbox-option { display: flex; gap: 0.75rem; align-items: flex-start; cursor: pointer; }

  /* ── Advanced panel ───────────────────────────────────────────────────────── */
  .advanced-panel {
    border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden;
  }
  .advanced-panel summary {
    padding: 0.625rem 0.875rem; font-size: 0.8125rem; font-weight: 600;
    color: var(--text-muted); cursor: pointer; user-select: none;
    list-style: none;
  }
  .advanced-panel summary::-webkit-details-marker { display: none; }
  .advanced-panel[open] summary { border-bottom: 1px solid var(--border); }
  .advanced-panel-body { padding: 1rem 0.875rem; display: flex; flex-direction: column; gap: 1rem; }

  /* ── Deploy ───────────────────────────────────────────────────────────────── */
  .deploy-btn { min-width: 10rem; }

  .create-error {
    padding: 0.875rem 1rem; border: 1px solid var(--error); border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--error) 8%, transparent); color: var(--error); font-size: 0.875rem;
  }
  .create-error strong { display: block; margin-bottom: 0.25rem; }
  .create-error p { margin: 0; }

  .progress-status { display: flex; align-items: center; gap: 0.75rem; font-size: 0.875rem; color: var(--text-muted); }
  .spinner {
    width: 1rem; height: 1rem; flex-shrink: 0;
    border: 2px solid var(--border); border-top-color: var(--accent);
    border-radius: 50%; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Output sections ─────────────────────────────────────────────────────── */
  .deploy-done-banner {
    background: color-mix(in srgb, var(--success) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--success) 30%, transparent);
    border-radius: var(--radius-sm); padding: 0.75rem 1rem;
    font-size: 0.9375rem; font-weight: 600; color: var(--success);
  }

  .output-section {
    border: 1px solid var(--border); border-radius: var(--radius-md);
    padding: 0.875rem 1rem; display: flex; flex-direction: column; gap: 0.5rem;
  }
  .output-section-header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
  .output-section-title {
    font-size: 0.8125rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.05em; color: var(--text-muted);
  }
  .output-launch-btn { font-size: 0.8125rem; padding: 0.375rem 0.75rem; text-decoration: none; }
  .output-url-row { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
  .output-url {
    font-family: monospace; font-size: 0.75rem; color: var(--text-secondary);
    background: var(--bg-elevated); padding: 0.3rem 0.5rem; border-radius: var(--radius-sm);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1;
  }
  .copy-btn { flex-shrink: 0; font-size: 0.75rem; padding: 0.3rem 0.5rem; }
  .output-hint { font-size: 0.8125rem; color: var(--text-muted); line-height: 1.55; margin: 0; }
  .output-hint a { color: var(--accent-text); }

  /* ── Hash details ─────────────────────────────────────────────────────────── */
  .hash-details { border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
  .hash-details summary { padding: 0.5rem 0.875rem; font-size: 0.8125rem; color: var(--text-muted); cursor: pointer; user-select: none; }
  .hash-details[open] summary { border-bottom: 1px solid var(--border); }
  .hash-row {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.5rem 0.875rem; border-bottom: 1px solid var(--border); font-size: 0.8125rem;
  }
  .hash-row:last-child { border-bottom: none; }
  .hash-label { font-weight: 600; color: var(--text-muted); flex-shrink: 0; width: 6rem; }
  .hash-val {
    font-family: monospace; font-size: 0.6875rem; color: var(--text-secondary);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;
  }

  /* ── WoCo listing section ────────────────────────────────────────────────── */
  .woco-listing-section {
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-radius: var(--radius-md); padding: 0.875rem 1rem;
    display: flex; flex-direction: column; gap: 0.625rem;
    background: color-mix(in srgb, var(--accent) 4%, transparent);
  }
  .woco-listed-banner { font-weight: 600; color: var(--success); font-size: 0.9375rem; }

  /* ── Sub-ENS result ──────────────────────────────────────────────────────── */
  .subens-section.subens-done {
    border-left: 3px solid #C7F23A;
    background: color-mix(in srgb, #C7F23A 4%, transparent);
  }
  .subens-claimed { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .subens-name { font-family: var(--font-mono, monospace); font-size: 0.9375rem; font-weight: 800; color: var(--text); letter-spacing: -0.01em; }
  .subens-arrow { font-size: 0.8125rem; color: var(--text-muted); }
  .subens-soon {
    display: inline-flex; align-items: center; gap: 0.25rem;
    padding: 0.2rem 0.5rem; font-size: 0.6875rem; font-weight: 600;
    color: var(--text-muted); background: color-mix(in srgb, var(--text-muted) 8%, transparent);
    border: 1px dashed var(--border); border-radius: 4px;
  }

  /* ── Custom domain ───────────────────────────────────────────────────────── */
  .domain-verified-banner {
    font-size: 0.875rem; color: #22c55e; padding: 0.75rem 1rem;
    background: rgba(34,197,94,0.1); border: 1px solid rgba(34,197,94,0.2);
    border-radius: var(--radius-sm);
  }
  .domain-instruction { font-size: 0.875rem; color: var(--text-secondary); margin: 0 0 0.75rem; }
  .dns-record { border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; margin-bottom: 0.5rem; }
  .dns-record-row {
    display: flex; align-items: center; padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border); font-size: 0.8125rem;
  }
  .dns-record-row:last-child { border-bottom: none; }
  .dns-label { width: 4rem; font-weight: 500; color: var(--text-muted); text-transform: uppercase; font-size: 0.6875rem; letter-spacing: 0.04em; }
  .dns-value { color: var(--accent-text); font-size: 0.8125rem; word-break: break-all; }
  .domain-input-row { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  .domain-input {
    flex: 1; padding: 0.5rem 0.625rem; font-size: 0.875rem; color: var(--text);
    background: var(--bg-input, var(--bg-surface)); border: 1px solid var(--border);
    border-radius: var(--radius-sm); transition: border-color var(--transition);
  }
  .domain-input:focus { outline: none; border-color: var(--accent); }
  .domain-error { font-size: 0.8125rem; color: var(--error); margin: 0.5rem 0 0; }

  /* ── Navigation row ──────────────────────────────────────────────────────── */
  .nav-row {
    display: flex; justify-content: space-between; align-items: center;
    padding-top: 0.5rem; border-top: 1px solid var(--border); margin-top: 0.5rem;
  }

  /* ── Buttons ─────────────────────────────────────────────────────────────── */
  .btn-primary {
    padding: 0.625rem 1.25rem; font-size: 0.9375rem; font-weight: 600;
    background: var(--accent); color: var(--accent-ink); border-radius: var(--radius-sm);
    transition: background var(--transition); text-decoration: none;
    display: inline-flex; align-items: center; gap: 0.375rem; white-space: nowrap;
  }
  .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
  .btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }

  .btn-ghost {
    padding: 0.375rem 0.875rem; font-size: 0.875rem; font-weight: 500;
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    color: var(--text-muted); transition: all var(--transition); white-space: nowrap;
  }
  .btn-ghost:hover { border-color: var(--accent); color: var(--accent-text); }
</style>
