<script lang="ts">
  import type { ClaimMode, OrderFieldType, SignedTicket } from "@woco/shared";
  import { deriveEncryptionKeypairFromPodSeed } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { createEventStreaming, type PublishProgress } from "../../api/events.js";
  import { createSeriesTickets } from "../../pod/signing.js";
  import { restorePodSeed } from "../../auth/pod-identity.js";
  import ImageUpload from "../events/ImageUpload.svelte";
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
  interface WaveItem {
    id: string;
    label: string;
    totalSupply: number;
    saleStart: string;
    saleEnd: string;
    showSaleWindow: boolean;
  }

  interface TierGroup {
    id: string;
    tierName: string;
    description: string;
    approvalRequired: boolean;
    waves: WaveItem[];
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
  let tierGroups = $state<TierGroup[]>([{
    id: crypto.randomUUID(),
    tierName: "General Admission",
    description: "",
    approvalRequired: false,
    waves: [{
      id: crypto.randomUUID(),
      label: "",
      totalSupply: 100,
      saleStart: "",
      saleEnd: "",
      showSaleWindow: false,
    }],
  }]);
  let fieldItems = $state<FieldItem[]>([]);
  let claimMode = $state<ClaimMode>("both");
  let eventImageDataUrl = $state<string | null>(null);
  let creatingEvent = $state(false);
  let createProgress = $state("");
  let createError = $state<string | null>(null);
  let createdEventId = $state<string | null>(null);

  // Step 3 — stored results (used by step 5 WoCo listing)
  interface StoredSeries {
    seriesId: string;
    name: string;
    description: string;
    totalSupply: number;
    approvalRequired: boolean;
    wave?: string;
    saleStart?: string;
    saleEnd?: string;
  }
  let storedSeries = $state<StoredSeries[]>([]);
  let storedSignedTickets = $state<Record<string, SignedTicket[]>>({});
  let storedEncryptionKey = $state<string | undefined>(undefined);

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
  let wocoEventId = $state<string | null>(null);

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
    tierGroups.push({
      id: crypto.randomUUID(),
      tierName: "",
      description: "",
      approvalRequired: false,
      waves: [{
        id: crypto.randomUUID(),
        label: "",
        totalSupply: 100,
        saleStart: "",
        saleEnd: "",
        showSaleWindow: false,
      }],
    });
  }

  function removeTier(id: string) {
    const idx = tierGroups.findIndex(t => t.id === id);
    if (idx !== -1) tierGroups.splice(idx, 1);
  }

  function addWave(tierId: string) {
    const tier = tierGroups.find(t => t.id === tierId);
    if (tier) {
      tier.waves.push({
        id: crypto.randomUUID(),
        label: "",
        totalSupply: 100,
        saleStart: "",
        saleEnd: "",
        showSaleWindow: false,
      });
    }
  }

  function removeWave(tierId: string, waveId: string) {
    const tier = tierGroups.find(t => t.id === tierId);
    if (tier) {
      const idx = tier.waves.findIndex(w => w.id === waveId);
      if (idx !== -1) tier.waves.splice(idx, 1);
    }
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
    createProgress = "Preparing tickets…";
    try {
      // Sign tickets for each series (same flow as PublishButton)
      const keypair = await auth.getPodKeypair();
      if (!keypair) { createError = "Could not get signing key"; creatingEvent = false; return; }

      const signedTickets: Record<string, SignedTicket[]> = {};

      // Flatten tier groups → individual series
      const allSeries = tierGroups.flatMap(tier =>
        tier.waves.map(wave => ({
          seriesId: wave.id,
          name: tier.waves.length > 1 && wave.label.trim()
            ? `${tier.tierName.trim()} — ${wave.label.trim()}`
            : tier.tierName.trim(),
          description: tier.description.trim(),
          totalSupply: wave.totalSupply,
          approvalRequired: tier.approvalRequired,
          ...(tier.waves.length > 1 && wave.label.trim() ? { wave: wave.label.trim() } : {}),
          ...(wave.saleStart ? { saleStart: wave.saleStart } : {}),
          ...(wave.saleEnd ? { saleEnd: wave.saleEnd } : {}),
        }))
      );

      const totalTickets = allSeries.reduce((sum, s) => sum + s.totalSupply, 0);
      let signed = 0;

      for (const s of allSeries) {
        signedTickets[s.seriesId] = await createSeriesTickets({
          eventId: "",
          seriesId: s.seriesId,
          seriesName: s.name,
          totalSupply: s.totalSupply,
          imageHash: "",
          creatorPrivateKey: keypair.privateKey,
          creatorPublicKeyHex: keypair.publicKeyHex,
        });
        signed += s.totalSupply;
        createProgress = `Signing tickets (${signed}/${totalTickets})…`;
      }

      // Derive encryption keypair from POD seed (no extra prompts)
      let encryptionKey: string | undefined;
      const podSeed = await restorePodSeed();
      if (podSeed) {
        const encKeypair = deriveEncryptionKeypairFromPodSeed(podSeed);
        encryptionKey = encKeypair.publicKeyHex;
      }

      createProgress = "Publishing to Swarm…";

      const result = await createEventStreaming(
        {
          event: {
            title: eventTitle.trim(),
            description: eventDescription.trim(),
            startDate: eventStartDate,
            endDate: eventEndDate,
            location: eventLocation.trim(),
          },
          series: allSeries,
          signedTickets: Object.fromEntries(
            allSeries.map(s => [s.seriesId, signedTickets[s.seriesId]])
          ),
          image: eventImageDataUrl!,
          creatorAddress: auth.parent as `0x${string}`,
          creatorPodKey: auth.podPublicKeyHex!,
          encryptionKey,
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
        },
        (p: PublishProgress) => { createProgress = p.message; },
        apiUrl,
      );

      if (result.ok && result.eventId) {
        createdEventId = result.eventId;
        // Store data for optional WoCo listing in step 5
        storedSeries = allSeries;
        storedSignedTickets = Object.fromEntries(
          allSeries.map(s => [s.seriesId, signedTickets[s.seriesId]])
        );
        storedEncryptionKey = encryptionKey;
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
    !!eventImageDataUrl &&
    tierGroups.length > 0 &&
    tierGroups.every(t =>
      !!t.tierName.trim() &&
      t.waves.length > 0 &&
      t.waves.every(w => w.totalSupply >= 1)
    )
  );

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
    if (!createdEventId || storedSeries.length === 0) return;
    listingOnWoco = true;
    wocoListError = null;
    wocoEventId = null;

    // Need pod keypair to re-sign (WoCo event has different Swarm feed — same signatures still valid)
    const podOk = await auth.ensurePodIdentity();
    if (!podOk) { wocoListError = "Identity needed for WoCo listing."; listingOnWoco = false; return; }

    try {
      const result = await createEventStreaming(
        {
          event: {
            title: eventTitle.trim(),
            description: eventDescription.trim(),
            startDate: eventStartDate,
            endDate: eventEndDate,
            location: eventLocation.trim(),
          },
          series: storedSeries,
          signedTickets: storedSignedTickets,
          image: eventImageDataUrl!,
          creatorAddress: auth.parent as `0x${string}`,
          creatorPodKey: auth.podPublicKeyHex!,
          encryptionKey: storedEncryptionKey,
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
        },
        () => {},
        // Call WoCo's own API (no override = uses VITE_API_URL = events-api.woco-net.com)
      );
      if (result.ok && result.eventId) {
        wocoEventId = result.eventId;
      } else {
        wocoListError = result.error || "WoCo listing failed";
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

          <div class="field-group">
            <label class="field-label">Event image <span class="required">*</span></label>
            <p class="field-hint" style="margin-top: 0;">Displayed as a banner at the top of your event page. Use a landscape image for best results.</p>
            <ImageUpload
              imageDataUrl={eventImageDataUrl}
              onchange={(url) => { eventImageDataUrl = url; }}
            />
          </div>

          <!-- Ticket tiers -->
          <div class="section-divider">Ticket tiers</div>

          {#each tierGroups as tier, i (tier.id)}
            <div class="tier-card">
              <div class="tier-card-header">
                <span class="tier-card-title">
                  Tier {i + 1}
                  {#if tier.tierName.trim()}
                    <span class="tier-name-preview">— {tier.tierName.trim()}</span>
                  {/if}
                </span>
                {#if tierGroups.length > 1}
                  <button class="tier-remove-btn" onclick={() => removeTier(tier.id)} type="button" aria-label="Remove tier">✕</button>
                {/if}
              </div>
              <div class="tier-card-body">
                <div class="row-2">
                  <div class="field-group">
                    <label class="field-label">Tier name <span class="required">*</span></label>
                    <input class="input" type="text" bind:value={tier.tierName} placeholder="General Admission" />
                  </div>
                  <div class="field-group">
                    <label class="field-label">Description <span class="optional">optional</span></label>
                    <input class="input" type="text" bind:value={tier.description} placeholder="What's included" />
                  </div>
                </div>

                <label class="checkbox-option">
                  <input type="checkbox" bind:checked={tier.approvalRequired} />
                  <span><strong>Require approval</strong> — you manually approve each claim from the dashboard</span>
                </label>

                <!-- Waves -->
                <div class="waves-header">
                  <span class="waves-label-text">Sale waves</span>
                  {#if tier.waves.length === 1}
                    <span class="waves-hint">Add more waves to split capacity by sale period (e.g. Early Bird → Standard)</span>
                  {/if}
                </div>

                <div class="waves-col-labels" class:has-label={tier.waves.length > 1}>
                  {#if tier.waves.length > 1}<span>Label</span>{/if}
                  <span>Capacity</span>
                  <span>Sale window</span>
                </div>

                {#each tier.waves as wave, wi (wave.id)}
                  <div class="wave-row">
                    <div class="wave-row-fields" class:has-label={tier.waves.length > 1}>
                      {#if tier.waves.length > 1}
                        <input
                          class="input wave-label-input"
                          type="text"
                          bind:value={wave.label}
                          placeholder={wi === 0 ? "Early Bird" : wi === 1 ? "Standard" : "Last Chance"}
                        />
                      {/if}
                      <input
                        class="input wave-supply-input"
                        type="number"
                        bind:value={wave.totalSupply}
                        min="1"
                        max="100000"
                        title="Capacity"
                      />
                      <button
                        class="btn-ghost wave-window-btn"
                        class:active={wave.showSaleWindow}
                        type="button"
                        onclick={() => { wave.showSaleWindow = !wave.showSaleWindow; }}
                        title="Set sale window"
                      >
                        {#if wave.saleStart || wave.saleEnd}
                          <span class="wave-date-summary">
                            {wave.saleStart ? wave.saleStart.slice(0, 10) : "…"}
                            {#if wave.saleEnd} → {wave.saleEnd.slice(0, 10)}{/if}
                          </span>
                        {:else}
                          Any time
                        {/if}
                        <span class="wave-window-chevron">{wave.showSaleWindow ? "▲" : "▼"}</span>
                      </button>
                      {#if tier.waves.length > 1}
                        <button class="tier-remove-btn" onclick={() => removeWave(tier.id, wave.id)} type="button" aria-label="Remove wave">✕</button>
                      {/if}
                    </div>
                    {#if wave.showSaleWindow}
                      <div class="row-2 sale-window-row">
                        <div class="field-group">
                          <label class="field-label">Opens</label>
                          <input class="input" type="datetime-local" bind:value={wave.saleStart} />
                        </div>
                        <div class="field-group">
                          <label class="field-label">Closes</label>
                          <input class="input" type="datetime-local" bind:value={wave.saleEnd} />
                        </div>
                      </div>
                    {/if}
                  </div>
                {/each}

                <button class="btn-add wave-add-btn" type="button" onclick={() => addWave(tier.id)}>+ Add wave</button>
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

      <div class="nav-row">
        <button class="btn-ghost" onclick={() => step = 3}>&larr; Back</button>
        <button class="btn-primary" onclick={() => step = 5}>
          Next: deploy &rarr;
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

            {#if wocoEventId}
              <div class="woco-listed-banner">&#127881; Listed on WoCo!</div>
              <div class="output-url-row" style="margin-top: 0.5rem;">
                <a
                  class="btn-primary output-launch-btn"
                  href="{import.meta.env.VITE_GATEWAY_URL || 'https://gateway.woco-net.com'}/bzz/{deployResult.contentHash}/"
                  target="_blank"
                  rel="noopener"
                >
                  View event site &#8599;
                </a>
                <a
                  class="btn-ghost"
                  href="/#/event/{wocoEventId}"
                  target="_blank"
                  rel="noopener"
                  style="padding: 0.4375rem 0.875rem; font-size: 0.8125rem;"
                >
                  View on WoCo &#8599;
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
                <span>Creating WoCo listing…</span>
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

  /* ── Waves ────────────────────────────────────────────────────────────────── */
  .waves-header {
    display: flex;
    align-items: baseline;
    gap: 0.625rem;
    margin-top: 0.25rem;
  }

  .waves-label-text {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .waves-hint {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .waves-col-labels {
    display: grid;
    grid-template-columns: 5rem 1fr;
    gap: 0.5rem;
    padding: 0 0.125rem;
  }

  .waves-col-labels.has-label {
    grid-template-columns: 1fr 5rem 1fr;
  }

  .waves-col-labels span {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .wave-row {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .wave-row-fields {
    display: grid;
    grid-template-columns: 5rem 1fr;
    align-items: center;
    gap: 0.5rem;
  }

  .wave-row-fields.has-label {
    grid-template-columns: 1fr 5rem 1fr auto;
  }

  .wave-supply-input {
    text-align: right;
    min-width: 0;
  }

  .wave-label-input {
    min-width: 0;
  }

  .wave-window-btn {
    font-size: 0.8125rem;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.625rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
  }

  .wave-window-btn.active {
    border-color: var(--accent);
    color: var(--accent-text);
    background: color-mix(in srgb, var(--accent) 6%, transparent);
  }

  .wave-date-summary {
    color: var(--text-secondary);
    font-size: 0.75rem;
  }

  .wave-window-chevron {
    font-size: 0.625rem;
    opacity: 0.6;
  }

  .wave-add-btn {
    margin-top: 0.25rem;
    font-size: 0.8125rem;
    padding: 0.375rem;
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
