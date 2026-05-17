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
  import { addSiteEvent } from "../api/sites.js";
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
  let claimMode = $state<ClaimMode>("both");
  let collectEmail = $state(false);
  let collectInfo = $state(false);
  let cryptoRecipientMissing = $state(false);
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
  let gatewayUrl = $state("https://gateway.woco-net.com");
  let paraApiKey = $state("");
  let listOnWoco = $state(false);
  let selectedSiteIds = $state<string[]>([]);
  let siteAddErrors = $state<Record<string, string>>({});

  // Step 3 — live + domain (deploy state)
  let deploying = $state(false);
  let deployError = $state<string | null>(null);
  let deployResult = $state<{ contentHash: string; feedManifestHash: string } | null>(null);

  let listingOnWoco = $state(false);
  let wocoListError = $state<string | null>(null);
  let wocoListed = $state(false);

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
      ? `${gatewayUrl.trim() || "https://gateway.ethswarm.org"}/bzz/${deployResult.contentHash}/`
      : ""
  );
  const dashboardUrl = $derived(eventSiteUrl ? `${eventSiteUrl}#/dashboard` : "");
  const ensHash = $derived(deployResult?.feedManifestHash ? `bzz://${deployResult.feedManifestHash}` : "");

  async function deployToSwarm(): Promise<boolean> {
    if (!createdEventId) return false;
    deploying = true;
    deployError = null;
    deployResult = null;
    try {
      const resp = await fetch(`${apiUrl}/api/site/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId: createdEventId,
          gatewayUrl: gatewayUrl.trim() || "https://gateway.ethswarm.org",
          apiUrl,
          ...(paraApiKey.trim() ? { paraApiKey: paraApiKey.trim() } : {}),
        }),
      });
      const json = await resp.json() as { ok: boolean; data?: { contentHash: string; feedManifestHash: string }; error?: string };
      if (json.ok && json.data) {
        deployResult = json.data;
        return true;
      }
      deployError = json.error || "Deploy failed";
      return false;
    } catch (e) {
      deployError = e instanceof Error ? e.message : "Deploy failed";
      return false;
    } finally {
      deploying = false;
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

  async function handleDeploy() {
    // Fire site-event additions concurrently with deploy — both are independent feed writes.
    const siteAddPromise = createdEventId && selectedSiteIds.length > 0
      ? Promise.allSettled(selectedSiteIds.map(id => addSiteEvent(id, createdEventId!)))
      : Promise.resolve([] as PromiseSettledResult<unknown>[]);

    const ok = await deployToSwarm();

    const siteResults = await siteAddPromise;
    siteAddErrors = {};
    siteResults.forEach((r, i) => {
      if (r.status === "rejected") {
        siteAddErrors[selectedSiteIds[i]] = (r.reason as Error)?.message ?? "Failed";
      } else if (r.status === "fulfilled") {
        const v = r.value as { ok?: boolean; error?: string };
        if (!v?.ok) siteAddErrors[selectedSiteIds[i]] = v?.error ?? "Failed";
      }
    });

    if (ok) {
      if (listOnWoco && !wocoListed) await createWocoListing();
      step = 3;
    }
  }

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
            disabled={cryptoRecipientMissing}
            disabledReason={cryptoRecipientMissing ? "Connect a wallet for crypto payouts above, or disable crypto on all tiers." : undefined}
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

      <div class="field-group">
        <label class="field-label" for="gw-picker">Gateway</label>
        <GatewayPicker bind:value={gatewayUrl} />
        <p class="field-hint">
          The Swarm gateway that will serve your event site.
        </p>
      </div>

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
