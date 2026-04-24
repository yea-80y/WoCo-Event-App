<script lang="ts">
  import type { ClaimMode, OrderField, PaymentConfig } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { authPost } from "../../api/client.js";
  import EventEditor from "../events/EventEditor.svelte";
  import PublishButton from "../events/PublishButton.svelte";
  import { registerDomain, verifyDomainDns, type DomainEntry } from "../../api/domains.js";
  import { onMount } from "svelte";

  // ── Types ────────────────────────────────────────────────────────────────────
  interface SetupCheckResult {
    apiOk: true;
    signerConfigured: boolean;
    signerAddress: string | null;
    signerError: string | null;
    batchConfigured: boolean;
    batchUsable: boolean;
    batchTTL: number | null;
    batchUtilization: number | null;
    beeConnected: boolean;
    beeVersion: string | null;
    beePeers: number | null;
    beeError: string | null;
    emailHashSecretSet: boolean;
  }

  // ── Wizard step ───────────────────────────────────────────────────────────────
  let step = $state(1);

  // Step 1 — computed values (available at runtime)
  const wocoHost = typeof window !== "undefined" ? window.location.hostname : "woco.eth.limo";

  // Step 2 — API verification
  let apiUrl = $state("");
  let apiUrlInput = $state("");
  let checking = $state(false);
  let checkResult = $state<SetupCheckResult | null>(null);
  let checkError = $state<string | null>(null);

  // Step 3 — event creation (shared <EventEditor /> owns the inputs; <PublishButton /> handles the publish pipeline)
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

  // Step 4 — site config
  let gatewayUrl = $state("https://gateway.woco-net.com");
  let paraApiKey = $state("");
  let listOnWoco = $state(false);

  // Step 5 — deploy state
  let deploying = $state(false);
  let deployError = $state<string | null>(null);
  let deployResult = $state<{ contentHash: string; feedManifestHash: string } | null>(null);

  // Step 5 — WoCo listing state
  let listingOnWoco = $state(false);
  let wocoListError = $state<string | null>(null);
  let wocoListed = $state(false);

  // Step 5 — custom domain state
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

  // Domain that must be in ALLOWED_HOSTS for the live site
  const gatewayHost = $derived(() => {
    try { return new URL(gatewayUrl).hostname; } catch { return "gateway.ethswarm.org"; }
  });

  // Full ALLOWED_HOSTS value to show the organiser
  const allowedHosts = $derived(
    [gatewayHost(), wocoHost, "gateway.woco-net.com", "localhost:5173"]
      .filter((h, i, arr) => h && arr.indexOf(h) === i)
      .join(",")
  );

  // ── Step 1: coming-from env template ─────────────────────────────────────────
  const envTemplate = $derived(`# apps/server/.env

# Required
FEED_PRIVATE_KEY=0x<your-64-hex-char-private-key>
POSTAGE_BATCH_ID=<your-batch-id>
BEE_URL=http://localhost:1633

# CRITICAL: include WoCo's domain so the wizard can create events,
# and the gateway domain so attendees can claim from your live site.
ALLOWED_HOSTS=${allowedHosts}

# Required — generate with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
EMAIL_HASH_SECRET=<random-32-byte-hex>
PAYMENT_QUOTE_SECRET=<random-32-byte-hex>

# Optional
PORT=3001`);

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function normaliseUrl(raw: string): string {
    let url = raw.trim().replace(/\/$/, "");
    if (url && !url.startsWith("http")) url = "https://" + url;
    return url;
  }

  function formatTTL(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    if (d >= 1) return `${d} day${d !== 1 ? "s" : ""}${h > 0 ? ` ${h}h` : ""}`;
    return `${h} hour${h !== 1 ? "s" : ""}`;
  }

  function ttlSeverity(seconds: number | null): "ok" | "warn" | "error" {
    if (seconds === null) return "error";
    if (seconds < 86400) return "error";       // < 1 day
    if (seconds < 7 * 86400) return "warn";    // < 7 days
    return "ok";
  }

  function copyText(text: string) {
    navigator.clipboard.writeText(text);
  }

  // ── Step 2: health check ──────────────────────────────────────────────────────
  async function runChecks() {
    const url = normaliseUrl(apiUrlInput);
    if (!url) return;
    checking = true;
    checkResult = null;
    checkError = null;
    try {
      const resp = await fetch(`${url}/api/admin/setup-check`, {
        signal: AbortSignal.timeout(10000),
      });

      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try {
          const text = await resp.text();
          if (text && text.length < 300 && !text.trimStart().startsWith("<")) {
            detail += `: ${text.trim()}`;
          }
        } catch { /* ignore */ }
        checkError = `Server returned ${detail}. Check the URL is correct and the server is running the latest WoCo version.`;
        return;
      }

      let json: unknown;
      try {
        json = await resp.json();
      } catch {
        checkError = "Server responded but not with JSON — it may be running an older version. Make sure you have the latest WoCo server code deployed.";
        return;
      }

      const j = json as { ok?: boolean; data?: SetupCheckResult; error?: string };
      if (j.ok && j.data) {
        checkResult = j.data;
        apiUrl = url;
      } else {
        checkError = j.error || "Unexpected response from setup-check";
      }
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") {
        checkError = "Request timed out — check that your server is running and the URL is reachable.";
      } else {
        checkError = e instanceof Error ? e.message : "Could not reach your API";
      }
    } finally {
      checking = false;
    }
  }

  // ── Step 3 helpers ───────────────────────────────────────────────────────────
  // ── Step 3: event creation ────────────────────────────────────────────────────
  // Handled entirely by <EventEditor /> + <PublishButton />. Publish target is the
  // organiser's own backend via `apiUrl`; skipAutoList=true keeps it off the WoCo
  // directory until they opt in on step 5.
  function onEventPublished(eventId: string) {
    createdEventId = eventId;
    step = 4;
  }

  // ── Step 5: deploy ────────────────────────────────────────────────────────────

  // WoCo's own API URL (the server that hosts this wizard)
  const wocoApiUrl = import.meta.env.VITE_API_URL || "";

  async function deployToSwarm() {
    if (!createdEventId) return;
    deploying = true;
    deployError = null;
    deployResult = null;

    try {
      const resp = await fetch(`${wocoApiUrl}/api/site/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId: createdEventId,
          gatewayUrl: gatewayUrl.trim() || "https://gateway.ethswarm.org",
          apiUrl: apiUrl,
          ...(paraApiKey.trim() ? { paraApiKey: paraApiKey.trim() } : {}),
        }),
      });
      const json = await resp.json() as { ok: boolean; data?: { contentHash: string; feedManifestHash: string }; error?: string };
      if (json.ok && json.data) {
        deployResult = json.data;
      } else {
        deployError = json.error || "Deploy failed";
      }
    } catch (e) {
      deployError = e instanceof Error ? e.message : "Deploy failed";
    } finally {
      deploying = false;
    }
  }

  // Derived URLs from deploy result
  const eventSiteUrl = $derived(
    deployResult
      ? `${gatewayUrl.trim() || "https://gateway.ethswarm.org"}/bzz/${deployResult.contentHash}/`
      : ""
  );
  const dashboardUrl = $derived(eventSiteUrl ? `${eventSiteUrl}#/dashboard` : "");
  const ensHash = $derived(deployResult?.feedManifestHash ? `bzz://${deployResult.feedManifestHash}` : "");

  async function createWocoListing() {
    if (!createdEventId) return;
    listingOnWoco = true;
    wocoListError = null;

    try {
      // List the event on WoCo's directory. WoCo fetches event details from sourceApiUrl
      // and stores it with apiUrl so the WoCo home page can load the event inline.
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
</script>

<!-- ────────────────────────────────────────────────────────────────────────────
  Wizard shell
──────────────────────────────────────────────────────────────────────────── -->
<div class="wizard">

  <!-- Progress bar -->
  <div class="progress-bar">
    {#each [1,2,3,4,5] as n}
      <div class="progress-step" class:done={step > n} class:active={step === n} class:future={step < n}>
        <div class="progress-dot">{step > n ? "✓" : n}</div>
        <span class="progress-label">
          {n === 1 ? "Setup" : n === 2 ? "Verify" : n === 3 ? "Event" : n === 4 ? "Site" : "Deploy"}
        </span>
      </div>
      {#if n < 5}
        <div class="progress-line" class:done={step > n}></div>
      {/if}
    {/each}
  </div>

  <!-- ── Step 1: Deploy your backend ─────────────────────────────────────────── -->
  {#if step === 1}
    <div class="step-content">
      <h2>Step 1 — Deploy your backend</h2>
      <p class="step-intro">
        Your event data lives on <em>your</em> server. First, download and run the
        WoCo backend. This takes about 5 minutes with Docker.
      </p>

      <div class="action-card">
        <div class="action-card-body">
          <h3>&#128230; Download backend package</h3>
          <p>Clone or download the WoCo repository — it includes the server, Docker setup, and this site builder.</p>
        </div>
        <a
          class="btn-primary"
          href="https://github.com/yea-80y/WoCo-Event-App/archive/refs/heads/main.zip"
          target="_blank"
          rel="noopener"
        >
          Download zip
        </a>
      </div>

      <div class="steps-list">
        <div class="mini-step">
          <span class="mini-step-num">1</span>
          <div>
            <strong>Unzip and configure</strong>
            <pre class="code">cd WoCo-Event-App-main
cp apps/server/.env.example apps/server/.env
# Edit apps/server/.env (see template below)</pre>
          </div>
        </div>
        <div class="mini-step">
          <span class="mini-step-num">2</span>
          <div>
            <strong>Start with Docker</strong>
            <pre class="code">docker compose up -d</pre>
          </div>
        </div>
        <div class="mini-step">
          <span class="mini-step-num">3</span>
          <div>
            <strong>Expose publicly</strong>
            <p class="note">Attendees' browsers must reach your server. Choose the option that fits your setup:</p>
            <div class="tunnel-options">
              <div class="tunnel-option">
                <div class="tunnel-option-head">
                  <span class="tunnel-label">VPS / own server</span>
                  <span class="tunnel-badge best">Most decentralised</span>
                </div>
                <p class="note">Run the server directly on a VPS (Hetzner, Linode, DigitalOcean, etc.) with a domain pointing to it. No tunnel needed — port 3001 exposed directly or via nginx reverse proxy.</p>
              </div>
              <div class="tunnel-option">
                <div class="tunnel-option-head">
                  <span class="tunnel-label">bore</span>
                  <span class="tunnel-badge oss">Open source</span>
                </div>
                <p class="note">Self-hostable tunnel. Run <code>bore local 3001 --to bore.pub</code> (uses the public relay) or host your own bore server.</p>
                <pre class="code">bore local 3001 --to bore.pub</pre>
              </div>
              <div class="tunnel-option">
                <div class="tunnel-option-head">
                  <span class="tunnel-label">Cloudflare Tunnel</span>
                  <span class="tunnel-badge neutral">Free, centralised</span>
                </div>
                <p class="note">Quick option for testing. No account needed for a temporary URL:</p>
                <pre class="code">cloudflared tunnel --url http://localhost:3001</pre>
              </div>
              <div class="tunnel-option">
                <div class="tunnel-option-head">
                  <span class="tunnel-label">ngrok</span>
                  <span class="tunnel-badge neutral">Free tier, centralised</span>
                </div>
                <pre class="code">ngrok http 3001</pre>
              </div>
            </div>
            <p class="note">Copy the generated URL — you'll need it in Step 2.</p>
          </div>
        </div>
      </div>

      <!-- .env template -->
      <div class="env-block">
        <div class="env-block-header">
          <span>apps/server/.env — recommended template</span>
          <button class="btn-ghost" onclick={() => copyText(envTemplate)}>Copy</button>
        </div>
        <pre class="env-pre">{envTemplate}</pre>
      </div>

      <!-- Warnings -->
      <div class="warnings">
        <div class="warning-item danger">
          <span class="warn-icon">&#128683;</span>
          <div>
            <strong>Back up FEED_PRIVATE_KEY</strong>
            <p>This key controls all your event feeds on Swarm. If you lose it you permanently lose write access to your data. Store it in a password manager before starting.</p>
          </div>
        </div>
        <div class="warning-item">
          <span class="warn-icon">&#128260;</span>
          <div>
            <strong>Need a Bee node?</strong>
            <p>Docker Compose only starts the WoCo server — you need a Bee node separately.
              See the <a href="https://docs.ethswarm.org/docs/bee/installation/quick-start" target="_blank" rel="noopener">Swarm quick-start guide</a>
              to run your own, or use a hosted Bee service.
              You'll also need a funded postage batch — buy BZZ on Gnosis Chain via
              <a href="https://app.ethswarm.org" target="_blank" rel="noopener">app.ethswarm.org</a>.
            </p>
          </div>
        </div>
      </div>

      <div class="nav-row">
        <span></span>
        <button class="btn-primary" onclick={() => step = 2}>
          I've started my server &rarr;
        </button>
      </div>
    </div>

  <!-- ── Step 2: Verify backend ───────────────────────────────────────────────── -->
  {:else if step === 2}
    <div class="step-content">
      <h2>Step 2 — Verify your backend</h2>
      <p class="step-intro">
        Enter your public API URL (the Cloudflare Tunnel URL or your own domain).
        We'll check that everything is connected and ready.
      </p>

      <div class="field-group">
        <label class="field-label" for="api-url">Your API URL</label>
        <div class="url-row">
          <input
            id="api-url"
            class="input"
            type="url"
            placeholder="https://your-server.example.com"
            bind:value={apiUrlInput}
            onkeydown={(e) => e.key === "Enter" && runChecks()}
          />
          <button
            class="btn-primary"
            onclick={runChecks}
            disabled={!apiUrlInput.trim() || checking}
          >
            {checking ? "Checking…" : "Run checks"}
          </button>
        </div>
        <p class="field-hint">
          The public URL of your server — your own domain, VPS IP, or tunnel URL
          (e.g. <code>*.trycloudflare.com</code>, bore, ngrok).
          Make sure <code>https://</code> is included and the server is reachable.
        </p>
      </div>

      {#if checkError}
        <div class="check-error">
          <strong>Could not reach your API</strong>
          <p>{checkError}</p>
          <p class="hint">Check that your server is running and the URL is correct. If using a tunnel (Cloudflare, bore, ngrok), make sure it is still running. If your server was already deployed, it may need updating — the <code>/api/admin/setup-check</code> endpoint was added in a recent version.</p>
        </div>
      {/if}

      {#if checkResult}
        <div class="checks-grid">
          <!-- API -->
          <div class="check-row ok">
            <span class="check-icon">&#10003;</span>
            <div class="check-body">
              <strong>API server</strong>
              <span>Reachable at {apiUrl}</span>
            </div>
          </div>

          <!-- Feed signer -->
          <div class="check-row" class:ok={checkResult.signerConfigured} class:error={!checkResult.signerConfigured}>
            <span class="check-icon">{checkResult.signerConfigured ? "✓" : "✗"}</span>
            <div class="check-body">
              <strong>Feed signer</strong>
              {#if checkResult.signerConfigured}
                <span class="addr">Owner: {checkResult.signerAddress}</span>
              {:else}
                <span>FEED_PRIVATE_KEY not set — add it to your .env and restart</span>
              {/if}
            </div>
          </div>

          <!-- Bee -->
          <div class="check-row" class:ok={checkResult.beeConnected} class:error={!checkResult.beeConnected}>
            <span class="check-icon">{checkResult.beeConnected ? "✓" : "✗"}</span>
            <div class="check-body">
              <strong>Bee node</strong>
              {#if checkResult.beeConnected}
                <span>
                  Connected{checkResult.beeVersion ? ` · v${checkResult.beeVersion}` : ""}
                  {#if checkResult.beePeers !== null}
                    · {checkResult.beePeers} peer{checkResult.beePeers !== 1 ? "s" : ""}
                    {#if checkResult.beePeers === 0}
                      <span class="badge warn">No peers — allow a few minutes to connect</span>
                    {/if}
                  {/if}
                </span>
              {:else}
                <span>{checkResult.beeError || "Cannot reach Bee node. Check BEE_URL in .env"}</span>
              {/if}
            </div>
          </div>

          <!-- Postage batch -->
          <div class="check-row"
            class:ok={checkResult.batchUsable && ttlSeverity(checkResult.batchTTL) === "ok"}
            class:warn={checkResult.batchUsable && ttlSeverity(checkResult.batchTTL) !== "ok"}
            class:error={!checkResult.batchConfigured}
            class:neutral={checkResult.batchConfigured && !checkResult.batchUsable && checkResult.beeConnected}
          >
            <span class="check-icon">
              {#if !checkResult.batchConfigured}✗
              {:else if !checkResult.batchUsable}–
              {:else if ttlSeverity(checkResult.batchTTL) === "warn"}⚠
              {:else}✓{/if}
            </span>
            <div class="check-body">
              <strong>Postage batch</strong>
              {#if !checkResult.batchConfigured}
                <span>POSTAGE_BATCH_ID not set — add it to .env and restart</span>
              {:else if !checkResult.beeConnected}
                <span>Skipped — Bee not connected</span>
              {:else if !checkResult.batchUsable}
                <span>POSTAGE_BATCH_ID is set — batch status not available via this Bee endpoint (gateway mode). Your uploads will work as long as the batch is valid.</span>
              {:else}
                <span>
                  Usable
                  {#if checkResult.batchTTL !== null}
                    · Expires in {formatTTL(checkResult.batchTTL)}
                    {#if ttlSeverity(checkResult.batchTTL) === "warn"}
                      <span class="badge warn">Consider renewing soon</span>
                    {:else if ttlSeverity(checkResult.batchTTL) === "error"}
                      <span class="badge error">Renew immediately</span>
                    {/if}
                  {/if}
                  {#if checkResult.batchUtilization !== null}
                    · {checkResult.batchUtilization}% full
                  {/if}
                </span>
              {/if}
            </div>
          </div>

          <!-- EMAIL_HASH_SECRET -->
          <div class="check-row" class:ok={checkResult.emailHashSecretSet} class:error={!checkResult.emailHashSecretSet}>
            <span class="check-icon">{checkResult.emailHashSecretSet ? "✓" : "✗"}</span>
            <div class="check-body">
              <strong>EMAIL_HASH_SECRET</strong>
              {#if checkResult.emailHashSecretSet}
                <span>Set — email addresses will be HMAC-hashed before storage</span>
              {:else}
                <span>Not set — server will refuse to start. Generate and add to .env, then restart</span>
              {/if}
            </div>
          </div>
        </div>

        {#if !checkResult.signerConfigured || !checkResult.beeConnected || !checkResult.emailHashSecretSet}
          <div class="check-note">
            Fix the errors above, then run the checks again. After updating .env, restart your server:
            <pre class="code">docker compose restart</pre>
          </div>
        {/if}
      {/if}

      <div class="nav-row">
        <button class="btn-ghost" onclick={() => step = 1}>&larr; Back</button>
        <button
          class="btn-primary"
          disabled={!checkResult?.apiOk}
          onclick={() => step = 3}
        >
          Looks good &rarr;
        </button>
      </div>
    </div>

  <!-- ── Step 3: Create your event ────────────────────────────────────────────── -->
  {:else if step === 3}
    <div class="step-content">
      <h2>Step 3 — Create your event</h2>
      <p class="step-intro">
        Event details are signed with your identity and stored on Swarm via your
        backend at <code class="inline-code">{apiUrl}</code>. The event stays off
        the WoCo directory until you opt in on step 5.
      </p>

      {#if !auth.isConnected}
        <div class="auth-prompt">
          <p>Sign in to create the event.</p>
          <button class="btn-primary" onclick={() => loginRequest.request()}>Sign in</button>
        </div>
      {:else}
        <div class="event-form">
          <EventEditor
            bind:title={eventTitle}
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
          />

          <PublishButton
            title={eventTitle}
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

      <div class="nav-row">
        <button class="btn-ghost" onclick={() => step = 2}>&larr; Back</button>
      </div>
    </div>

  <!-- ── Step 4: Site config ───────────────────────────────────────────────────── -->
  {:else if step === 4}
    <div class="step-content">
      <h2>Step 4 — Configure your site</h2>
      <p class="step-intro">
        Event created! &#10003; Now configure where the site will load assets from,
        and optionally provide a Para API key for email-based wallet login.
      </p>

      {#if createdEventId}
        <div class="success-banner">
          &#127881; Event created — ID: <code>{createdEventId}</code>
        </div>
      {/if}

      <div class="field-group">
        <label class="field-label" for="gw-url">Swarm gateway URL</label>
        <input
          id="gw-url"
          class="input"
          type="url"
          bind:value={gatewayUrl}
          placeholder="https://gateway.ethswarm.org"
        />
        <p class="field-hint">
          Used to load your event images and assets from Swarm.
          <code>gateway.ethswarm.org</code> is the recommended public gateway for production.
          Do <strong>not</strong> use <code>gateway.woco-net.com</code> — that's a personal node, not suitable for large-scale traffic.
        </p>
      </div>

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
          Enables email-based wallet login for attendees. Get your own key at
          <a href="https://developer.getpara.com" target="_blank" rel="noopener">developer.getpara.com</a>.
        </p>
      </div>

      <!-- ALLOWED_HOSTS reminder -->
      <div class="info-box">
        <h4>&#128275; Update ALLOWED_HOSTS on your server</h4>
        <p>
          Your live site will be served from <code>{gatewayHost()}</code>.
          Attendees claiming tickets from that domain need your server to accept their session.
          Make sure your <code>.env</code> has:
        </p>
        <div class="env-block">
          <div class="env-block-header">
            <span>apps/server/.env</span>
            <button class="btn-ghost" onclick={() => copyText(`ALLOWED_HOSTS=${allowedHosts}`)}>Copy</button>
          </div>
          <pre class="env-pre">ALLOWED_HOSTS={allowedHosts}</pre>
        </div>
        <p class="note">After updating, restart: <code>docker compose restart</code></p>
      </div>

      <!-- List on WoCo option -->
      <div class="list-woco-card">
        <label class="checkbox-option list-woco-check">
          <input type="checkbox" bind:checked={listOnWoco} />
          <div>
            <strong>List this event on WoCo</strong>
            <p class="note">
              Your event will appear in WoCo's public directory at
              <a href="https://woco.eth.limo" target="_blank" rel="noopener">woco.eth.limo</a>
              so attendees can discover it. WoCo will also create a sub-ENS record
              (<code>yourname.woco.eth</code>) pointing to your event site — making it
              accessible at a stable ENS address.
            </p>
            <p class="note" style="margin-top: 0.375rem; color: var(--text-muted);">
              <em>ENS sub-record creation coming soon — tick to signal intent and get listed in the directory.</em>
            </p>
          </div>
        </label>
      </div>

      {#if wocoListed}
        <div class="success-banner">&#10003; Listed on WoCo directory!</div>
      {:else if wocoListError}
        <div class="create-error">WoCo listing failed: {wocoListError}</div>
      {/if}

      <div class="nav-row">
        <button class="btn-ghost" onclick={() => step = 3}>&larr; Back</button>
        <button
          class="btn-primary"
          disabled={listingOnWoco}
          onclick={async () => {
            if (listOnWoco && !wocoListed) await createWocoListing();
            step = 5;
          }}
        >
          {listingOnWoco ? "Listing on WoCo…" : "Next: deploy →"}
        </button>
      </div>
    </div>

  <!-- ── Step 5: Deploy ────────────────────────────────────────────────────────── -->
  {:else if step === 5}
    <div class="step-content">
      <h2>Step 5 — Deploy your site</h2>
      <p class="step-intro">
        Your event site will be built and uploaded to Swarm in one click.
        You'll receive a content hash you can set as an ENS record — or just share the gateway link directly.
      </p>

      {#if !deployResult}
        <!-- Pre-deploy: summary + button -->
        <div class="deploy-summary">
          <div class="deploy-summary-row">
            <span class="deploy-label">Event</span>
            <span class="deploy-val">{eventTitle.trim()}</span>
          </div>
          <div class="deploy-summary-row">
            <span class="deploy-label">API server</span>
            <span class="deploy-val mono">{apiUrl}</span>
          </div>
          <div class="deploy-summary-row">
            <span class="deploy-label">Gateway</span>
            <span class="deploy-val mono">{gatewayUrl.trim() || "https://gateway.ethswarm.org"}</span>
          </div>
          {#if listOnWoco}
            <div class="deploy-summary-row">
              <span class="deploy-label">WoCo listing</span>
              <span class="deploy-val">Yes — will appear on woco.eth.limo</span>
            </div>
          {/if}
        </div>

        {#if deployError}
          <div class="create-error">
            <strong>Deploy failed</strong>
            <p>{deployError}</p>
            <p class="note">Make sure the WoCo server has the latest <code>dist-site/</code> files rsynced.
              Run <code>npm run build:site</code> locally and add <code>apps/web/dist-site/</code> to the server rsync, then retry.</p>
          </div>
        {/if}

        {#if deploying}
          <div class="progress-status">
            <div class="spinner"></div>
            <span>Building and uploading to Swarm… this takes 20–60 seconds.</span>
          </div>
        {/if}

        <div class="nav-row">
          <button class="btn-ghost" onclick={() => step = 4}>&larr; Back</button>
          <button
            class="btn-primary deploy-btn"
            disabled={deploying}
            onclick={deployToSwarm}
          >
            {deploying ? "Deploying…" : "Deploy to Swarm →"}
          </button>
        </div>

      {:else}
        <!-- Post-deploy: show all output -->
        <div class="deploy-done-banner">
          &#9989; Site deployed to Swarm
        </div>

        <!-- Event site URL -->
        <div class="output-section">
          <div class="output-section-header">
            <span class="output-section-title">Event site</span>
            <a
              class="btn-primary output-launch-btn"
              href={eventSiteUrl}
              target="_blank"
              rel="noopener"
            >
              Launch &#8599;
            </a>
          </div>
          <div class="output-url-row">
            <code class="output-url">{eventSiteUrl}</code>
            <button class="btn-ghost copy-btn" onclick={() => copyText(eventSiteUrl)}>Copy</button>
          </div>
          <p class="output-hint">
            This is your public event page. Share this link with attendees — no sign-in required to view it.
          </p>
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
          <p class="output-hint">
            Sign in with your wallet to view orders, decrypt attendee data, and manage approvals.
            Bookmark this — it's not linked from the public page.
          </p>
        </div>

        <!-- ENS section -->
        <div class="output-section">
          <div class="output-section-header">
            <span class="output-section-title">ENS content hash</span>
          </div>
          {#if deployResult.feedManifestHash}
            <div class="output-url-row">
              <code class="output-url">{ensHash}</code>
              <button class="btn-ghost copy-btn" onclick={() => copyText(ensHash)}>Copy</button>
            </div>
            <p class="output-hint">
              Set this as your ENS content record at
              <a href="https://app.ens.domains" target="_blank" rel="noopener">app.ens.domains</a>.
              This is a <strong>feed manifest</strong> — future redeploys update the content without
              changing this hash, so your ENS record never needs to change.
            </p>
          {:else}
            <div class="output-url-row">
              <code class="output-url">bzz://{deployResult.contentHash}</code>
              <button class="btn-ghost copy-btn" onclick={() => copyText(`bzz://${deployResult.contentHash}`)}>Copy</button>
            </div>
            <p class="output-hint">Direct content hash — set this on your ENS record.</p>
          {/if}
          <p class="output-hint" style="margin-top: 0.5rem;">
            Or point your own domain (sub-ENS or custom domain) at the gateway URL above
            via a <code>_dnslink</code> TXT record or a redirect.
          </p>
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
              <a
                class="btn-primary output-launch-btn"
                href="https://{domainEntry.hostname}"
                target="_blank"
                rel="noopener"
              >
                Visit site &#8599;
              </a>
            </div>

          {:else if domainEntry}
            <div class="domain-pending">
              <p class="domain-instruction">
                Add this DNS record to <strong>{domainEntry.hostname}</strong>:
              </p>
              <div class="dns-record">
                <div class="dns-record-row">
                  <span class="dns-label">Type</span>
                  <code class="dns-value">CNAME</code>
                </div>
                <div class="dns-record-row">
                  <span class="dns-label">Name</span>
                  <code class="dns-value">{domainEntry.hostname.split('.')[0]}</code>
                </div>
                <div class="dns-record-row">
                  <span class="dns-label">Target</span>
                  <code class="dns-value">{domainEntry.cnameTarget || "sites.woco-net.com"}</code>
                </div>
              </div>

              {#if domainError}
                <p class="domain-error">{domainError}</p>
              {/if}

              <button
                class="btn-primary"
                style="margin-top: 0.75rem;"
                onclick={handleVerifyDomain}
                disabled={domainVerifying}
              >
                {domainVerifying ? "Checking DNS..." : "Verify domain"}
              </button>
              <p class="output-hint" style="margin-top: 0.5rem;">
                DNS changes can take a few minutes to propagate. Click Verify once you've added the record.
              </p>
            </div>

          {:else}
            <p class="output-hint">
              Point your own domain at this event site. Visitors will see your content served from Swarm.
            </p>
            <div class="domain-input-row">
              <input
                type="text"
                class="domain-input"
                placeholder="events.mycompany.com"
                bind:value={customDomainInput}
                onkeydown={(e) => e.key === "Enter" && handleRegisterDomain()}
              />
              <button
                class="btn-primary"
                onclick={handleRegisterDomain}
                disabled={domainRegistering || !customDomainInput.trim()}
              >
                {domainRegistering ? "Registering..." : "Add domain"}
              </button>
            </div>
            {#if domainError}
              <p class="domain-error">{domainError}</p>
            {/if}
            <p class="output-hint" style="margin-top: 0.5rem;">
              You'll need access to your domain's DNS settings (e.g. Cloudflare, Namecheap, Route 53).
            </p>
          {/if}
        </div>

        <!-- Raw hashes (collapsible reference) -->
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

        <!-- WoCo listing -->
        {#if listOnWoco}
          <div class="woco-listing-section">
            <div class="woco-listing-header">
              <span class="output-section-title">WoCo directory listing</span>
            </div>

            {#if wocoListed}
              <div class="woco-listed-banner">&#127881; Listed on WoCo!</div>
              <p class="output-hint" style="margin-top: 0.5rem;">
                Your event is now in the WoCo directory. Visitors will be routed directly to your standalone site.
              </p>
              <div class="output-url-row" style="margin-top: 0.5rem;">
                <a
                  class="btn-primary output-launch-btn"
                  href="{import.meta.env.VITE_GATEWAY_URL || 'https://gateway.woco-net.com'}/bzz/{deployResult.contentHash}/"
                  target="_blank"
                  rel="noopener"
                >
                  View event site &#8599;
                </a>
              </div>
            {:else if wocoListError}
              <div class="create-error" style="margin: 0;">{wocoListError}</div>
              <button class="btn-primary" style="margin-top: 0.75rem;" onclick={createWocoListing} disabled={listingOnWoco}>
                Retry WoCo listing
              </button>
            {:else if listingOnWoco}
              <div class="progress-status">
                <div class="spinner"></div>
                <span>Adding to WoCo directory…</span>
              </div>
            {:else}
              <p class="output-hint">
                Your event will appear on <strong>woco.eth.limo</strong> and attendees will be routed to your
                standalone event site at the gateway URL above.
              </p>
              <button class="btn-primary" onclick={createWocoListing}>
                Create WoCo listing →
              </button>
            {/if}
          </div>
        {/if}

        <div class="nav-row" style="margin-top: 1rem;">
          <span></span>
          <button class="btn-ghost" onclick={() => { step = 4; deployResult = null; }}>
            &larr; Change config &amp; redeploy
          </button>
        </div>
      {/if}
    </div>
  {/if}
</div>

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

  .progress-step.done .progress-dot {
    background: var(--success);
    color: #fff;
  }

  .progress-step.active .progress-dot {
    background: var(--accent);
    color: #fff;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
  }

  .progress-step.future .progress-dot {
    background: var(--bg-elevated);
    color: var(--text-muted);
    border: 1px solid var(--border);
  }

  .progress-label {
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }

  .progress-step.done .progress-label,
  .progress-step.active .progress-label {
    color: var(--text-secondary);
  }

  .progress-step.future .progress-label {
    color: var(--text-muted);
  }

  .progress-line {
    flex: 1;
    height: 2px;
    background: var(--border);
    margin-bottom: 1.25rem;
    transition: background var(--transition);
  }

  .progress-line.done {
    background: var(--success);
  }

  /* ── Step content ─────────────────────────────────────────────────────────── */
  .step-content {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  h2 {
    color: var(--text);
    font-size: 1.375rem;
    font-weight: 700;
    margin: 0;
    letter-spacing: -0.01em;
  }

  .step-intro {
    color: var(--text-secondary);
    font-size: 0.9375rem;
    line-height: 1.6;
    margin: 0;
  }

  .step-intro em {
    color: var(--accent-text);
    font-style: normal;
    font-weight: 500;
  }

  /* ── Action card ──────────────────────────────────────────────────────────── */
  .action-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 1rem 1.25rem;
    border: 1px solid var(--accent);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--accent) 6%, transparent);
  }

  .action-card-body h3 {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
    margin: 0 0 0.25rem;
  }

  .action-card-body p {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }

  /* ── Mini steps (numbered list) ───────────────────────────────────────────── */
  .steps-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .mini-step {
    display: flex;
    gap: 0.875rem;
    align-items: flex-start;
  }

  .mini-step-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
    background: var(--accent-subtle);
    color: var(--accent-text);
    font-size: 0.75rem;
    font-weight: 700;
    flex-shrink: 0;
    margin-top: 0.1rem;
  }

  .mini-step strong {
    display: block;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 0.375rem;
  }

  .mini-step .note {
    font-size: 0.8125rem;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0.25rem 0;
  }

  /* ── tunnel options ───────────────────────────────────────────────────────── */
  .tunnel-options {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    margin: 0.5rem 0;
  }

  .tunnel-option {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.75rem;
  }

  .tunnel-option-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }

  .tunnel-label {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text);
  }

  .tunnel-badge {
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.4rem;
    border-radius: 9999px;
  }

  .tunnel-badge.best {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--accent-text);
  }

  .tunnel-badge.oss {
    background: color-mix(in srgb, #3fb950 15%, transparent);
    color: #3fb950;
  }

  .tunnel-badge.neutral {
    background: var(--bg-elevated, var(--bg-surface));
    color: var(--text-muted);
    border: 1px solid var(--border);
  }

  /* ── env block ────────────────────────────────────────────────────────────── */
  .env-block {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .env-block-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0.875rem;
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border);
    font-size: 0.8125rem;
    color: var(--text-muted);
    font-family: monospace;
  }

  .env-pre {
    margin: 0;
    padding: 0.875rem 1rem;
    font-family: monospace;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    background: var(--bg-surface);
    white-space: pre;
    overflow-x: auto;
    line-height: 1.8;
  }

  /* ── Warnings ────────────────────────────────────────────────────────────── */
  .warnings {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .warning-item {
    display: flex;
    gap: 0.75rem;
    padding: 0.875rem 1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    align-items: flex-start;
  }

  .warn-icon {
    font-size: 1.125rem;
    flex-shrink: 0;
    margin-top: 0.1rem;
  }

  .warning-item strong {
    display: block;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 0.25rem;
  }

  .warning-item p {
    font-size: 0.8125rem;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
  }

  .warning-item a {
    color: var(--accent-text);
  }

  .warning-item.danger {
    border-color: #f8514933;
    background: #f8514910;
  }

  .warning-item.danger strong {
    color: #f85149;
  }

  /* ── Step 2: checks ──────────────────────────────────────────────────────── */
  .url-row {
    display: flex;
    gap: 0.625rem;
  }

  .url-row .input {
    flex: 1;
  }

  .check-error {
    padding: 1rem;
    border: 1px solid var(--error);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--error) 8%, transparent);
    color: var(--error);
    font-size: 0.875rem;
  }

  .check-error strong {
    display: block;
    margin-bottom: 0.25rem;
    font-weight: 600;
  }

  .check-error p {
    margin: 0 0 0.375rem;
    font-family: monospace;
  }

  .check-error .hint {
    color: var(--text-muted);
    font-family: inherit;
    font-size: 0.8125rem;
  }

  .checks-grid {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .check-row {
    display: flex;
    align-items: flex-start;
    gap: 0.875rem;
    padding: 0.875rem 1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
  }

  .check-row.ok {
    border-color: var(--success);
    background: color-mix(in srgb, var(--success) 6%, transparent);
  }

  .check-row.warn {
    border-color: #f59e0b;
    background: color-mix(in srgb, #f59e0b 6%, transparent);
  }

  .check-row.error {
    border-color: var(--error);
    background: color-mix(in srgb, var(--error) 6%, transparent);
  }

  .check-icon {
    font-size: 1rem;
    flex-shrink: 0;
    margin-top: 0.125rem;
  }

  .check-row.ok .check-icon { color: var(--success); }
  .check-row.warn .check-icon { color: #f59e0b; }
  .check-row.error .check-icon { color: var(--error); }
  .check-row.neutral .check-icon { color: var(--text-muted); }

  .check-body {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    font-size: 0.875rem;
  }

  .check-body strong {
    font-weight: 600;
    color: var(--text);
  }

  .check-body span {
    color: var(--text-secondary);
    font-size: 0.8125rem;
  }

  .addr {
    font-family: monospace !important;
    font-size: 0.75rem !important;
    color: var(--text-muted) !important;
    word-break: break-all;
  }

  .badge {
    display: inline-block;
    font-size: 0.6875rem;
    font-weight: 600;
    padding: 0.125rem 0.5rem;
    border-radius: 9999px;
    margin-left: 0.375rem;
    vertical-align: middle;
  }

  .badge.warn {
    background: color-mix(in srgb, #f59e0b 15%, transparent);
    color: #f59e0b;
  }

  .badge.error {
    background: color-mix(in srgb, var(--error) 15%, transparent);
    color: var(--error);
  }

  .check-note {
    padding: 0.875rem 1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.875rem;
    color: var(--text-secondary);
    line-height: 1.5;
  }

  /* ── Step 3: event form ──────────────────────────────────────────────────── */
  .auth-prompt {
    text-align: center;
    padding: 2.5rem;
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    color: var(--text-muted);
  }

  .auth-prompt p { margin: 0 0 1rem; }

  .event-form {
    display: flex;
    flex-direction: column;
    gap: 1.125rem;
  }

  /* ── Step 4: info box ────────────────────────────────────────────────────── */
  .info-box {
    padding: 1rem 1.125rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
  }

  .info-box h4 {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
    margin: 0 0 0.5rem;
  }

  .info-box p {
    font-size: 0.875rem;
    color: var(--text-secondary);
    margin: 0 0 0.75rem;
    line-height: 1.5;
  }

  .info-box .note {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0.5rem 0 0;
  }

  .success-banner {
    padding: 0.75rem 1rem;
    border: 1px solid var(--success);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--success) 8%, transparent);
    color: var(--success);
    font-size: 0.875rem;
  }

  .success-banner code {
    font-family: monospace;
    font-size: 0.8rem;
  }

  /* ── Step 4 — WoCo listing card ─────────────────────────────────────────── */
  .list-woco-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1rem 1.125rem;
    background: var(--bg-surface);
  }

  .list-woco-check {
    align-items: flex-start;
  }

  /* ── Step 5 — deploy summary ─────────────────────────────────────────────── */
  .deploy-summary {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .deploy-summary-row {
    display: flex;
    align-items: baseline;
    gap: 1rem;
    padding: 0.625rem 1rem;
    border-bottom: 1px solid var(--border);
    font-size: 0.875rem;
  }

  .deploy-summary-row:last-child {
    border-bottom: none;
  }

  .deploy-label {
    font-weight: 600;
    color: var(--text-muted);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    flex-shrink: 0;
    width: 5rem;
  }

  .deploy-val {
    color: var(--text-secondary);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .deploy-btn {
    min-width: 10rem;
  }

  /* ── Step 5 — post-deploy output ─────────────────────────────────────────── */
  .deploy-done-banner {
    background: color-mix(in srgb, var(--success) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--success) 30%, transparent);
    border-radius: var(--radius-sm);
    padding: 0.75rem 1rem;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--success);
  }

  .output-section {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 0.875rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .output-section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .output-section-title {
    font-size: 0.8125rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }

  .output-launch-btn {
    font-size: 0.8125rem;
    padding: 0.375rem 0.75rem;
    text-decoration: none;
  }

  .output-url-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .output-url {
    font-family: monospace;
    font-size: 0.75rem;
    color: var(--text-secondary);
    background: var(--bg-elevated);
    padding: 0.3rem 0.5rem;
    border-radius: var(--radius-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }

  .copy-btn {
    flex-shrink: 0;
    font-size: 0.75rem;
    padding: 0.3rem 0.5rem;
  }

  .output-hint {
    font-size: 0.8125rem;
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0;
  }

  /* ── Hash details ─────────────────────────────────────────────────────────── */
  .hash-details {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .hash-details summary {
    padding: 0.5rem 0.875rem;
    font-size: 0.8125rem;
    color: var(--text-muted);
    cursor: pointer;
    user-select: none;
  }

  .hash-details[open] summary {
    border-bottom: 1px solid var(--border);
  }

  .hash-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.875rem;
    border-bottom: 1px solid var(--border);
    font-size: 0.8125rem;
  }

  .hash-row:last-child { border-bottom: none; }

  .hash-label {
    font-weight: 600;
    color: var(--text-muted);
    flex-shrink: 0;
    width: 6rem;
  }

  .hash-val {
    font-family: monospace;
    font-size: 0.6875rem;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  /* ── WoCo listing section ────────────────────────────────────────────────── */
  .woco-listing-section {
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-radius: var(--radius-md);
    padding: 0.875rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    background: color-mix(in srgb, var(--accent) 4%, transparent);
  }

  .woco-listing-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .woco-listed-banner {
    font-weight: 600;
    color: var(--success);
    font-size: 0.9375rem;
  }

  /* ── Shared: form fields ─────────────────────────────────────────────────── */
  .field-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .field-label {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .input {
    width: 100%;
    padding: 0.625rem 0.875rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 0.9375rem;
    transition: border-color var(--transition);
    font-family: inherit;
  }

  .input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .field-hint {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }

  .field-hint a { color: var(--accent-text); }

  .inline-code {
    font-family: monospace;
    font-size: 0.8rem;
    background: var(--bg-elevated);
    padding: 0.1rem 0.375rem;
    border-radius: 4px;
  }

  /* ── Shared: code blocks ─────────────────────────────────────────────────── */
  .code {
    font-family: monospace;
    font-size: 0.8125rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.625rem 0.875rem;
    margin: 0.375rem 0 0;
    white-space: pre;
    overflow-x: auto;
    color: var(--text-secondary);
    line-height: 1.7;
    display: block;
  }

  /* ── Navigation row ──────────────────────────────────────────────────────── */
  .nav-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border);
    margin-top: 0.5rem;
  }

  /* ── Buttons ─────────────────────────────────────────────────────────────── */
  .btn-primary {
    padding: 0.625rem 1.25rem;
    font-size: 0.9375rem;
    font-weight: 600;
    background: var(--accent);
    color: #fff;
    border-radius: var(--radius-sm);
    transition: background var(--transition);
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    white-space: nowrap;
  }

  .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
  .btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }

  .btn-ghost {
    padding: 0.375rem 0.875rem;
    font-size: 0.875rem;
    font-weight: 500;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    transition: all var(--transition);
    white-space: nowrap;
  }

  .btn-ghost:hover {
    border-color: var(--accent);
    color: var(--accent-text);
  }

  /* ── Custom domain ──────────────────────────────────────────────────────── */
  .domain-verified-banner {
    font-size: 0.875rem;
    color: #22c55e;
    padding: 0.75rem 1rem;
    background: rgba(34, 197, 94, 0.1);
    border: 1px solid rgba(34, 197, 94, 0.2);
    border-radius: var(--radius-sm);
  }

  .domain-pending {
    margin-top: 0.5rem;
  }

  .domain-instruction {
    font-size: 0.875rem;
    color: var(--text-secondary);
    margin: 0 0 0.75rem;
  }

  .dns-record {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    margin-bottom: 0.5rem;
  }

  .dns-record-row {
    display: flex;
    align-items: center;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border);
    font-size: 0.8125rem;
  }

  .dns-record-row:last-child {
    border-bottom: none;
  }

  .dns-label {
    width: 4rem;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    font-size: 0.6875rem;
    letter-spacing: 0.04em;
  }

  .dns-value {
    color: var(--accent-text);
    font-size: 0.8125rem;
    word-break: break-all;
  }

  .domain-input-row {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .domain-input {
    flex: 1;
    padding: 0.5rem 0.625rem;
    font-size: 0.875rem;
    color: var(--text);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    transition: border-color var(--transition);
  }

  .domain-input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-subtle);
  }

  .domain-error {
    font-size: 0.8125rem;
    color: var(--error);
    margin: 0.5rem 0 0;
  }
</style>
