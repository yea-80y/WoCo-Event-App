<script lang="ts">
  interface Props { gatewayUrl?: string; }
  let { gatewayUrl = "https://gateway.woco-net.com" }: Props = $props();

  interface SetupCheckResult {
    apiOk: true;
    signerConfigured: boolean;
    signerAddress: string | null;
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

  const wocoHost = typeof window !== "undefined" ? window.location.hostname : "woco.eth.limo";
  const gatewayHost = $derived(() => {
    try { return new URL(gatewayUrl).hostname; } catch { return "gateway.ethswarm.org"; }
  });
  const allowedHosts = $derived(
    [gatewayHost(), wocoHost, "gateway.woco-net.com", "localhost:5173"]
      .filter((h, i, arr) => h && arr.indexOf(h) === i)
      .join(",")
  );
  const envTemplate = $derived(`# apps/server/.env

FEED_PRIVATE_KEY=0x<your-64-hex-char-private-key>
POSTAGE_BATCH_ID=<your-batch-id>
BEE_URL=http://localhost:1633

ALLOWED_HOSTS=${allowedHosts}

# generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
EMAIL_HASH_SECRET=<random-32-byte-hex>
PAYMENT_QUOTE_SECRET=<random-32-byte-hex>

PORT=3001`);

  let apiUrlInput = $state("");
  let checking = $state(false);
  let checkResult = $state<SetupCheckResult | null>(null);
  let checkError = $state<string | null>(null);

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
    if (seconds < 86400) return "error";
    if (seconds < 7 * 86400) return "warn";
    return "ok";
  }

  function copyText(text: string) { navigator.clipboard.writeText(text); }

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
          if (text && text.length < 300 && !text.trimStart().startsWith("<")) detail += `: ${text.trim()}`;
        } catch { /* ignore */ }
        checkError = `Server returned ${detail}. Check the URL and that the server is running the latest WoCo version.`;
        return;
      }
      let json: unknown;
      try { json = await resp.json(); }
      catch {
        checkError = "Server responded but not with JSON — may be an older version.";
        return;
      }
      const j = json as { ok?: boolean; data?: SetupCheckResult; error?: string };
      if (j.ok && j.data) checkResult = j.data;
      else checkError = j.error || "Unexpected response from setup-check";
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError")
        checkError = "Request timed out — check the server is running and the URL is reachable.";
      else checkError = e instanceof Error ? e.message : "Could not reach your API";
    } finally {
      checking = false;
    }
  }
</script>

<section class="adv">
  <div class="adv-header">
    <span class="adv-kicker">// ADVANCED</span>
    <p class="adv-hint">Self-hosted backend setup and health check. Accessible via <code>?advanced=1</code>.</p>
  </div>

  <div class="field-group">
    <div class="env-block-header"><span>apps/server/.env</span><button class="btn-ghost" onclick={() => copyText(envTemplate)}>Copy</button></div>
    <pre class="env-pre">{envTemplate}</pre>
  </div>

  <div class="field-group">
    <label class="field-label" for="adv-api-url">API URL to health-check</label>
    <div class="url-row">
      <input id="adv-api-url" class="input" type="url" placeholder="https://your-server.example.com"
        bind:value={apiUrlInput} onkeydown={(e) => e.key === "Enter" && runChecks()} />
      <button class="btn-primary" onclick={runChecks} disabled={!apiUrlInput.trim() || checking}>
        {checking ? "Checking…" : "Run checks"}
      </button>
    </div>
  </div>

  {#if checkError}
    <div class="check-error"><strong>Could not reach API</strong><p>{checkError}</p></div>
  {/if}

  {#if checkResult}
    <div class="checks-grid">
      <div class="check-row ok">
        <span class="check-icon">✓</span>
        <div class="check-body"><strong>API server</strong><span>Reachable</span></div>
      </div>
      <div class="check-row" class:ok={checkResult.signerConfigured} class:error={!checkResult.signerConfigured}>
        <span class="check-icon">{checkResult.signerConfigured ? "✓" : "✗"}</span>
        <div class="check-body">
          <strong>Feed signer</strong>
          {#if checkResult.signerConfigured}
            <span class="addr">{checkResult.signerAddress}</span>
          {:else}
            <span>FEED_PRIVATE_KEY not set</span>
          {/if}
        </div>
      </div>
      <div class="check-row" class:ok={checkResult.beeConnected} class:error={!checkResult.beeConnected}>
        <span class="check-icon">{checkResult.beeConnected ? "✓" : "✗"}</span>
        <div class="check-body">
          <strong>Bee node</strong>
          {#if checkResult.beeConnected}
            <span>Connected{checkResult.beeVersion ? ` · v${checkResult.beeVersion}` : ""}{checkResult.beePeers !== null ? ` · ${checkResult.beePeers} peers` : ""}</span>
          {:else}
            <span>{checkResult.beeError || "Cannot reach Bee. Check BEE_URL in .env"}</span>
          {/if}
        </div>
      </div>
      <div class="check-row"
        class:ok={checkResult.batchUsable && ttlSeverity(checkResult.batchTTL) === "ok"}
        class:warn={checkResult.batchUsable && ttlSeverity(checkResult.batchTTL) !== "ok"}
        class:error={!checkResult.batchConfigured}>
        <span class="check-icon">
          {#if !checkResult.batchConfigured}✗
          {:else if !checkResult.batchUsable}–
          {:else if ttlSeverity(checkResult.batchTTL) === "warn"}⚠
          {:else}✓{/if}
        </span>
        <div class="check-body">
          <strong>Postage batch</strong>
          {#if !checkResult.batchConfigured}<span>POSTAGE_BATCH_ID not set</span>
          {:else if !checkResult.batchUsable}<span>Set — status not available (gateway mode)</span>
          {:else}<span>Usable{checkResult.batchTTL !== null ? ` · Expires in ${formatTTL(checkResult.batchTTL)}` : ""}{checkResult.batchUtilization !== null ? ` · ${checkResult.batchUtilization}% full` : ""}</span>
          {/if}
        </div>
      </div>
      <div class="check-row" class:ok={checkResult.emailHashSecretSet} class:error={!checkResult.emailHashSecretSet}>
        <span class="check-icon">{checkResult.emailHashSecretSet ? "✓" : "✗"}</span>
        <div class="check-body">
          <strong>EMAIL_HASH_SECRET</strong>
          {#if checkResult.emailHashSecretSet}<span>Set</span>
          {:else}<span>Not set — add to .env and restart</span>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</section>

<style>
  .adv {
    margin-top: 2.5rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }
  .adv-header { display: flex; flex-direction: column; gap: 0.25rem; }
  .adv-kicker {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-muted);
  }
  .adv-hint { margin: 0; font-size: 0.875rem; color: var(--text-muted); }
  .adv-hint code { font-size: 0.8125rem; }

  .field-group { display: flex; flex-direction: column; gap: 0.375rem; }
  .field-label { font-size: 0.875rem; font-weight: 600; color: var(--text); }
  .input {
    width: 100%; padding: 0.625rem 0.875rem;
    background: var(--bg-input, var(--bg-surface)); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text); font-size: 0.9375rem;
    transition: border-color var(--transition); font-family: inherit;
  }
  .input:focus { outline: none; border-color: var(--accent); }

  .env-block-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 0.5rem 0.875rem;
    background: var(--bg-elevated); border: 1px solid var(--border);
    border-bottom: none; border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    font-size: 0.8125rem; color: var(--text-muted); font-family: monospace;
  }
  .env-pre {
    margin: 0; padding: 0.875rem 1rem; font-family: monospace; font-size: 0.8125rem;
    color: var(--text-secondary); background: var(--bg-surface);
    border: 1px solid var(--border); border-radius: 0 0 var(--radius-sm) var(--radius-sm);
    white-space: pre; overflow-x: auto; line-height: 1.8;
  }

  .url-row { display: flex; gap: 0.625rem; }
  .url-row .input { flex: 1; }

  .btn-primary {
    padding: 0.625rem 1.25rem; font-size: 0.9375rem; font-weight: 600;
    background: var(--accent); color: var(--accent-ink);
    border-radius: var(--radius-sm); transition: background var(--transition);
    white-space: nowrap; display: inline-flex; align-items: center; gap: 0.375rem;
  }
  .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
  .btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }

  .btn-ghost {
    padding: 0.375rem 0.875rem; font-size: 0.875rem; font-weight: 500;
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    color: var(--text-muted); transition: all var(--transition); white-space: nowrap;
  }
  .btn-ghost:hover { border-color: var(--accent); color: var(--accent-text); }

  .check-error {
    padding: 1rem; border: 1px solid var(--error); border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--error) 8%, transparent); color: var(--error); font-size: 0.875rem;
  }
  .check-error strong { display: block; margin-bottom: 0.25rem; }
  .check-error p { margin: 0; font-family: monospace; }

  .checks-grid { display: flex; flex-direction: column; gap: 0.5rem; }
  .check-row {
    display: flex; align-items: flex-start; gap: 0.875rem;
    padding: 0.875rem 1rem; border: 1px solid var(--border);
    border-radius: var(--radius-sm); background: var(--bg-surface);
  }
  .check-row.ok { border-color: var(--success); background: color-mix(in srgb, var(--success) 6%, transparent); }
  .check-row.warn { border-color: #f59e0b; background: color-mix(in srgb, #f59e0b 6%, transparent); }
  .check-row.error { border-color: var(--error); background: color-mix(in srgb, var(--error) 6%, transparent); }
  .check-icon { font-size: 1rem; flex-shrink: 0; margin-top: 0.125rem; }
  .check-row.ok .check-icon { color: var(--success); }
  .check-row.warn .check-icon { color: #f59e0b; }
  .check-row.error .check-icon { color: var(--error); }
  .check-body { display: flex; flex-direction: column; gap: 0.125rem; font-size: 0.875rem; }
  .check-body strong { font-weight: 600; color: var(--text); }
  .check-body span { color: var(--text-secondary); font-size: 0.8125rem; }
  .addr { font-family: monospace !important; font-size: 0.75rem !important; color: var(--text-muted) !important; word-break: break-all; }
</style>
