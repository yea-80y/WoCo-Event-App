<script lang="ts">
  import type { ClaimMode, OrderFieldType } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { createEventStreaming, type PublishProgress } from "../../api/events.js";
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

  // Step 3 — event creation
  interface SeriesItem {
    id: string;
    name: string;
    description: string;
    totalSupply: number;
    wave: string;
    saleStart: string;
    saleEnd: string;
    approvalRequired: boolean;
    showSaleWindow: boolean;
  }

  interface FieldItem {
    id: string;
    type: OrderFieldType;
    label: string;
    required: boolean;
    placeholder: string;
    options: string[];
    newOption: string;
  }

  let eventTitle = $state("");
  let eventDescription = $state("");
  let eventStartDate = $state("");
  let eventEndDate = $state("");
  let eventLocation = $state("");
  let seriesItems = $state<SeriesItem[]>([{
    id: crypto.randomUUID(),
    name: "General Admission",
    description: "",
    totalSupply: 100,
    wave: "",
    saleStart: "",
    saleEnd: "",
    approvalRequired: false,
    showSaleWindow: false,
  }]);
  let fieldItems = $state<FieldItem[]>([]);
  let claimMode = $state<ClaimMode>("both");
  let creatingEvent = $state(false);
  let createProgress = $state("");
  let createError = $state<string | null>(null);
  let createdEventId = $state<string | null>(null);

  // Step 4 — site config
  let gatewayUrl = $state("https://gateway.ethswarm.org");
  let paraApiKey = $state("");

  // Step 5 — env content
  const envContent = $derived(
    createdEventId
      ? [
          `VITE_API_URL=${apiUrl}`,
          `VITE_GATEWAY_URL=${gatewayUrl.trim() || "https://gateway.ethswarm.org"}`,
          `VITE_EVENT_ID=${createdEventId}`,
          paraApiKey.trim()
            ? `VITE_PARA_API_KEY=${paraApiKey.trim()}`
            : `# VITE_PARA_API_KEY=your_para_api_key_here`,
        ].join("\n")
      : ""
  );

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
  function addTier() {
    seriesItems.push({
      id: crypto.randomUUID(),
      name: "",
      description: "",
      totalSupply: 100,
      wave: "",
      saleStart: "",
      saleEnd: "",
      approvalRequired: false,
      showSaleWindow: false,
    });
  }

  function removeTier(id: string) {
    const idx = seriesItems.findIndex(s => s.id === id);
    if (idx !== -1) seriesItems.splice(idx, 1);
  }

  function addField() {
    fieldItems.push({
      id: crypto.randomUUID(),
      type: "text" as OrderFieldType,
      label: "",
      required: false,
      placeholder: "",
      options: [],
      newOption: "",
    });
  }

  function removeField(id: string) {
    const idx = fieldItems.findIndex(f => f.id === id);
    if (idx !== -1) fieldItems.splice(idx, 1);
  }

  function addOption(fieldId: string) {
    const f = fieldItems.find(f => f.id === fieldId);
    if (f && f.newOption.trim()) {
      f.options.push(f.newOption.trim());
      f.newOption = "";
    }
  }

  function removeOption(fieldId: string, optIdx: number) {
    const f = fieldItems.find(f => f.id === fieldId);
    if (f) f.options.splice(optIdx, 1);
  }

  // ── Step 3: event creation ────────────────────────────────────────────────────
  async function createEvent() {
    createError = null;

    if (!auth.isConnected) {
      const ok = await loginRequest.request();
      if (!ok) return;
    }

    const sessionOk = await auth.ensureSession();
    if (!sessionOk) { createError = "Session setup failed or was cancelled."; return; }

    const podOk = await auth.ensurePodIdentity();
    if (!podOk) { createError = "Identity setup failed or was cancelled."; return; }

    creatingEvent = true;
    createProgress = "Preparing...";
    try {
      const result = await createEventStreaming(
        {
          title: eventTitle.trim(),
          description: eventDescription.trim(),
          startDate: eventStartDate,
          endDate: eventEndDate,
          location: eventLocation.trim(),
          imageDataUrl: null,
          series: seriesItems.map(s => ({
            seriesId: s.id,
            name: s.name.trim(),
            description: s.description.trim(),
            totalSupply: s.totalSupply,
            approvalRequired: s.approvalRequired,
            ...(s.wave.trim() ? { wave: s.wave.trim() } : {}),
            ...(s.saleStart ? { saleStart: s.saleStart } : {}),
            ...(s.saleEnd ? { saleEnd: s.saleEnd } : {}),
          })),
          claimMode,
          orderFields: [
            ...(claimMode !== "wallet" ? [
              { id: "__email", type: "email" as const, label: "Email", required: true, placeholder: "your@email.com" },
            ] : []),
            ...fieldItems.map(f => ({
              id: f.id,
              type: f.type,
              label: f.label.trim(),
              required: f.required,
              ...(f.placeholder.trim() ? { placeholder: f.placeholder.trim() } : {}),
              ...(f.options.length > 0 ? { options: f.options } : {}),
            })),
          ],
          encryptionKey: "",  // server generates this
        },
        (p: PublishProgress) => { createProgress = p.message; },
        apiUrl,
      );

      if (result.ok && result.eventId) {
        createdEventId = result.eventId;
        step = 4;
      } else {
        createError = result.error || "Event creation failed";
      }
    } catch (e) {
      createError = e instanceof Error ? e.message : "Event creation failed";
    } finally {
      creatingEvent = false;
      createProgress = "";
    }
  }

  const step3Valid = $derived(
    !!eventTitle.trim() &&
    !!eventStartDate &&
    !!eventEndDate &&
    eventStartDate <= eventEndDate &&
    seriesItems.length > 0 &&
    seriesItems.every(s => !!s.name.trim() && s.totalSupply >= 1)
  );

  // ── Step 5: download ──────────────────────────────────────────────────────────
  function downloadEnvFile() {
    const blob = new Blob([envContent], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = ".env.site";
    a.click();
    URL.revokeObjectURL(url);
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
        </div>

        {#if !checkResult.signerConfigured || !checkResult.beeConnected}
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
        Enter your event details. These will be signed with your identity and
        stored on Swarm via your backend at <code class="inline-code">{apiUrl}</code>.
      </p>

      {#if !auth.isConnected}
        <div class="auth-prompt">
          <p>Sign in to create the event.</p>
          <button class="btn-primary" onclick={() => loginRequest.request()}>Sign in</button>
        </div>
      {:else}
        <div class="event-form">

          <!-- Event details -->
          <div class="field-group">
            <label class="field-label" for="ev-title">Event title <span class="required">*</span></label>
            <input id="ev-title" class="input" type="text" bind:value={eventTitle} placeholder="Devcon Side Event" />
          </div>

          <div class="field-group">
            <label class="field-label" for="ev-desc">Description</label>
            <textarea id="ev-desc" class="input textarea" bind:value={eventDescription} rows="3" placeholder="Tell attendees what to expect…"></textarea>
          </div>

          <div class="row-2">
            <div class="field-group">
              <label class="field-label" for="ev-start">Start date &amp; time <span class="required">*</span></label>
              <input id="ev-start" class="input" type="datetime-local" bind:value={eventStartDate} />
            </div>
            <div class="field-group">
              <label class="field-label" for="ev-end">End date &amp; time <span class="required">*</span></label>
              <input id="ev-end" class="input" type="datetime-local" bind:value={eventEndDate} />
            </div>
          </div>

          <div class="field-group">
            <label class="field-label" for="ev-location">Location</label>
            <input id="ev-location" class="input" type="text" bind:value={eventLocation} placeholder="Bangkok, Thailand" />
          </div>

          <!-- Ticket tiers -->
          <div class="section-divider">Ticket tiers</div>

          {#each seriesItems as tier, i (tier.id)}
            <div class="tier-card">
              <div class="tier-card-header">
                <span class="tier-card-title">
                  Tier {i + 1}
                  {#if tier.name.trim()}
                    <span class="tier-name-preview">— {tier.name.trim()}</span>
                  {/if}
                  {#if tier.wave.trim()}
                    <span class="wave-badge">{tier.wave.trim()}</span>
                  {/if}
                </span>
                {#if seriesItems.length > 1}
                  <button class="tier-remove-btn" onclick={() => removeTier(tier.id)} type="button" aria-label="Remove tier">✕</button>
                {/if}
              </div>
              <div class="tier-card-body">
                <div class="row-2">
                  <div class="field-group">
                    <label class="field-label">Name <span class="required">*</span></label>
                    <input class="input" type="text" bind:value={tier.name} placeholder="General Admission" />
                  </div>
                  <div class="field-group">
                    <label class="field-label">Capacity <span class="required">*</span></label>
                    <input class="input" type="number" bind:value={tier.totalSupply} min="1" max="100000" />
                  </div>
                </div>

                <div class="field-group">
                  <label class="field-label">Description <span class="optional">optional</span></label>
                  <input class="input" type="text" bind:value={tier.description} placeholder="What's included in this tier" />
                </div>

                <div class="row-2">
                  <div class="field-group">
                    <label class="field-label">Wave label <span class="optional">optional</span></label>
                    <input class="input" type="text" bind:value={tier.wave} placeholder="Early Bird" />
                  </div>
                  <div class="field-group">
                    <label class="field-label">&nbsp;</label>
                    <button
                      class="btn-ghost sale-window-toggle"
                      type="button"
                      onclick={() => { tier.showSaleWindow = !tier.showSaleWindow; }}
                    >
                      {tier.showSaleWindow ? "▼" : "▶"} Sale window
                    </button>
                  </div>
                </div>

                {#if tier.showSaleWindow}
                  <div class="row-2 sale-window-row">
                    <div class="field-group">
                      <label class="field-label">Opens</label>
                      <input class="input" type="datetime-local" bind:value={tier.saleStart} />
                    </div>
                    <div class="field-group">
                      <label class="field-label">Closes</label>
                      <input class="input" type="datetime-local" bind:value={tier.saleEnd} />
                    </div>
                  </div>
                {/if}

                <label class="checkbox-option">
                  <input type="checkbox" bind:checked={tier.approvalRequired} />
                  <span><strong>Require approval</strong> — you manually approve each claim from the dashboard</span>
                </label>
              </div>
            </div>
          {/each}

          <button class="btn-add" type="button" onclick={addTier}>+ Add tier</button>

          <!-- Attendee questions -->
          <div class="section-divider">
            Attendee questions <span class="optional">optional</span>
          </div>
          <p class="section-hint">Collect information from attendees at claim time. Add text fields, dropdowns, or checkboxes — email is always collected automatically for email claims.</p>

          {#each fieldItems as field, fi (field.id)}
            <div class="field-card">
              <div class="tier-card-header">
                <span class="tier-card-title">
                  Question {fi + 1}
                  {#if field.label.trim()}
                    <span class="tier-name-preview">— {field.label.trim()}</span>
                  {/if}
                </span>
                <button class="tier-remove-btn" onclick={() => removeField(field.id)} type="button" aria-label="Remove question">✕</button>
              </div>
              <div class="tier-card-body">
                <div class="row-2">
                  <div class="field-group">
                    <label class="field-label">Type</label>
                    <select class="input" bind:value={field.type}>
                      <option value="text">Short text</option>
                      <option value="textarea">Long text</option>
                      <option value="email">Email</option>
                      <option value="tel">Phone</option>
                      <option value="select">Select / Radio</option>
                      <option value="checkbox">Checkbox</option>
                    </select>
                  </div>
                  <div class="field-group">
                    <label class="field-label">Label <span class="required">*</span></label>
                    <input class="input" type="text" bind:value={field.label} placeholder="e.g. Dietary requirements" />
                  </div>
                </div>

                {#if field.type !== "checkbox" && field.type !== "select"}
                  <div class="field-group">
                    <label class="field-label">Placeholder <span class="optional">optional</span></label>
                    <input class="input" type="text" bind:value={field.placeholder} placeholder="Hint shown inside the input" />
                  </div>
                {/if}

                {#if field.type === "select"}
                  <div class="field-group">
                    <label class="field-label">Options</label>
                    {#if field.options.length > 0}
                      <div class="option-list">
                        {#each field.options as opt, oi}
                          <span class="option-chip">
                            {opt}
                            <button class="option-remove" onclick={() => removeOption(field.id, oi)} type="button" aria-label="Remove option">✕</button>
                          </span>
                        {/each}
                      </div>
                    {/if}
                    <div class="add-option-row">
                      <input
                        class="input"
                        type="text"
                        bind:value={field.newOption}
                        placeholder="Add option…"
                        onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); addOption(field.id); } }}
                      />
                      <button class="btn-ghost" type="button" onclick={() => addOption(field.id)}>Add</button>
                    </div>
                  </div>
                {/if}

                <label class="checkbox-option">
                  <input type="checkbox" bind:checked={field.required} />
                  <span><strong>Required</strong></span>
                </label>
              </div>
            </div>
          {/each}

          <button class="btn-add" type="button" onclick={addField}>+ Add question</button>

          <!-- Claiming -->
          <div class="section-divider">Claiming</div>

          <div class="field-group">
            <label class="field-label">How can people claim?</label>
            <div class="radio-group">
              <label class="radio-option">
                <input type="radio" bind:group={claimMode} value="wallet" />
                <span><strong>Wallet only</strong> — sign in with MetaMask or Para</span>
              </label>
              <label class="radio-option">
                <input type="radio" bind:group={claimMode} value="email" />
                <span><strong>Email only</strong> — rate-limited, no wallet needed</span>
              </label>
              <label class="radio-option">
                <input type="radio" bind:group={claimMode} value="both" />
                <span><strong>Wallet or email</strong> — maximum accessibility</span>
              </label>
            </div>
          </div>

          {#if createError}
            <div class="create-error">{createError}</div>
          {/if}

          {#if creatingEvent}
            <div class="progress-status">
              <div class="spinner"></div>
              <span>{createProgress || "Creating event on your server…"}</span>
            </div>
          {/if}
        </div>
      {/if}

      <div class="nav-row">
        <button class="btn-ghost" onclick={() => step = 2}>&larr; Back</button>
        {#if auth.isConnected}
          <button
            class="btn-primary"
            disabled={!step3Valid || creatingEvent}
            onclick={createEvent}
          >
            {creatingEvent ? "Creating…" : "Create event →"}
          </button>
        {/if}
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
          Do <strong>not</strong> use <code>gateway.woco-net.com</code> — that's a personal node, not suitable for Devcon-scale traffic.
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

      <div class="nav-row">
        <button class="btn-ghost" onclick={() => step = 3}>&larr; Back</button>
        <button class="btn-primary" onclick={() => step = 5}>
          Generate site config &rarr;
        </button>
      </div>
    </div>

  <!-- ── Step 5: Build & deploy ────────────────────────────────────────────────── -->
  {:else if step === 5}
    <div class="step-content">
      <h2>Step 5 — Build &amp; deploy your site</h2>
      <p class="step-intro">
        Download the config file, build your site locally, upload it to Swarm,
        and set the content hash on your ENS domain.
      </p>

      <!-- env.site download -->
      <div class="output-card">
        <div class="output-card-header">
          <span class="mono">apps/web/.env.site</span>
          <button class="btn-ghost" onclick={() => copyText(envContent)}>Copy</button>
        </div>
        <pre class="env-pre">{envContent}</pre>
        <button class="btn-primary download-btn" onclick={downloadEnvFile}>
          &#11015; Download .env.site
        </button>
      </div>

      <!-- Build instructions -->
      <div class="instructions">
        <h3>Build &amp; upload commands</h3>
        <ol class="inst-list">
          <li>
            <strong>Place the config file</strong>
            <pre class="code">mv ~/Downloads/.env.site WoCo-Event-App/apps/web/.env.site</pre>
          </li>
          <li>
            <strong>Build the site</strong>
            <pre class="code">cd WoCo-Event-App
npm install
npm run build:site</pre>
            <p class="note">Output: <code>apps/web/dist-site/</code></p>
          </li>
          <li>
            <strong>Configure your upload credentials</strong>
            <p class="note">Create <code>scripts/.env</code> (your Bee node upload credentials — keep this private):</p>
            <pre class="code">FEED_PRIVATE_KEY=0x&lt;same-key-as-server&gt;
SITE_POSTAGE_BATCH_ID=&lt;your-batch-id&gt;
SITE_BEE_URL=http://localhost:1633
SITE_FEED_TOPIC=woco-site</pre>
          </li>
          <li>
            <strong>Upload to Swarm</strong>
            <pre class="code">npm run upload:site</pre>
            <p class="note">The script prints a <strong>feed manifest hash</strong> and a direct content hash.</p>
          </li>
          <li>
            <strong>Set your ENS content hash</strong>
            <p class="note">Use the <strong>feed manifest</strong> for an updatable ENS entry (deploy new versions without changing the ENS record):</p>
            <pre class="code"># In ENS Manager (app.ens.domains) — Content field:
bzz://&lt;feed-manifest-hash&gt;</pre>
            <p class="note">
              Or use the direct content hash for a static pin:<br />
              <code>bzz://&lt;content-hash&gt;</code>
            </p>
          </li>
        </ol>

        <div class="info-box" style="margin-top: 1.5rem;">
          <h4>&#127881; What you'll have</h4>
          <ul class="checklist">
            <li>A standalone event page at your ENS domain (e.g. <code>devcon.eth.limo</code>)</li>
            <li>Your attendees can claim tickets without ever touching WoCo's servers</li>
            <li>Dashboard at <code>your-ens-domain/#/dashboard</code> — sign in with your wallet to manage orders</li>
            <li>Re-run <code>npm run upload:site</code> any time to push updates without changing ENS</li>
          </ul>
        </div>
      </div>

      <div class="nav-row">
        <button class="btn-ghost" onclick={() => step = 4}>&larr; Back</button>
      </div>
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

  .row-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.875rem;
  }

  @media (max-width: 480px) {
    .row-2 { grid-template-columns: 1fr; }
  }

  .section-divider {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    padding-top: 0.5rem;
    border-top: 1px solid var(--border);
  }

  .radio-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .radio-option, .checkbox-option {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    font-size: 0.875rem;
    color: var(--text-secondary);
    cursor: pointer;
    line-height: 1.5;
  }

  .radio-option input, .checkbox-option input {
    margin-top: 0.2rem;
    flex-shrink: 0;
    accent-color: var(--accent);
  }

  .radio-option strong, .checkbox-option strong {
    color: var(--text);
  }

  .create-error {
    padding: 0.75rem 1rem;
    border: 1px solid var(--error);
    border-radius: var(--radius-sm);
    color: var(--error);
    font-size: 0.875rem;
    background: color-mix(in srgb, var(--error) 8%, transparent);
  }

  .progress-status {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 0.875rem;
  }

  .spinner {
    width: 1rem;
    height: 1rem;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

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

  /* ── Step 5 ───────────────────────────────────────────────────────────────── */
  .output-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .output-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0.875rem;
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border);
  }

  .output-card-header .mono {
    font-family: monospace;
    font-size: 0.8125rem;
    color: var(--text-muted);
  }

  .download-btn {
    width: 100%;
    border-radius: 0;
    border-top: 1px solid var(--border);
    padding: 0.75rem;
  }

  .instructions h3 {
    font-size: 1rem;
    font-weight: 600;
    color: var(--text);
    margin: 0 0 1rem;
  }

  .inst-list {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    padding-left: 1.25rem;
    margin: 0;
  }

  .inst-list li {
    font-size: 0.9375rem;
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .inst-list strong {
    display: block;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 0.375rem;
  }

  .inst-list .note {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0.375rem 0;
    line-height: 1.5;
  }

  .checklist {
    padding-left: 1.125rem;
    margin: 0.5rem 0 0;
  }

  .checklist li {
    font-size: 0.875rem;
    color: var(--text-secondary);
    margin-bottom: 0.375rem;
    line-height: 1.5;
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

  .required { color: var(--error); font-size: 0.8rem; }
  .optional { font-weight: 400; color: var(--text-muted); font-size: 0.8125rem; }

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

  .textarea { resize: vertical; min-height: 80px; }

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

  /* ── Ticket tiers + question cards ──────────────────────────────────────── */
  .tier-card, .field-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .tier-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.625rem 0.875rem;
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border);
    gap: 0.5rem;
  }

  .tier-card-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-wrap: wrap;
  }

  .tier-name-preview {
    font-weight: 400;
    color: var(--text-muted);
  }

  .wave-badge {
    font-size: 0.6875rem;
    font-weight: 600;
    padding: 0.1rem 0.45rem;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--accent-text);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .tier-remove-btn {
    font-size: 0.8125rem;
    color: var(--text-muted);
    padding: 0.2rem 0.4rem;
    border-radius: var(--radius-sm);
    transition: all var(--transition);
    flex-shrink: 0;
    line-height: 1;
  }

  .tier-remove-btn:hover {
    color: var(--error);
    background: color-mix(in srgb, var(--error) 10%, transparent);
  }

  .tier-card-body {
    padding: 0.875rem;
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  .sale-window-toggle {
    width: 100%;
    text-align: left;
    font-size: 0.8125rem;
  }

  .sale-window-row {
    padding-top: 0.25rem;
  }

  /* ── Add tier / add question button ─────────────────────────────────────── */
  .btn-add {
    width: 100%;
    padding: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--accent-text);
    border: 1px dashed var(--accent);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--accent) 4%, transparent);
    transition: all var(--transition);
    text-align: center;
  }

  .btn-add:hover {
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }

  /* ── Section hint ────────────────────────────────────────────────────────── */
  .section-hint {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: -0.5rem 0 0;
    line-height: 1.5;
  }

  /* ── Select options (field type dropdown) ───────────────────────────────── */
  select.input {
    cursor: pointer;
  }

  /* ── Option chips (select/radio field builder) ───────────────────────────── */
  .option-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin-bottom: 0.375rem;
  }

  .option-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.2rem 0.5rem 0.2rem 0.625rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 9999px;
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }

  .option-remove {
    font-size: 0.6875rem;
    color: var(--text-muted);
    line-height: 1;
    padding: 0.1rem;
    border-radius: 50%;
    transition: all var(--transition);
  }

  .option-remove:hover {
    color: var(--error);
    background: color-mix(in srgb, var(--error) 12%, transparent);
  }

  .add-option-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .add-option-row .input {
    flex: 1;
  }
</style>
