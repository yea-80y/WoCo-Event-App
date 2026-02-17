<script lang="ts">
  import type { EventFeed, OrderEntry, SealedBox, OrderField } from "@woco/shared";
  import { deriveEncryptionKeypairFromPodSeed, openJson } from "@woco/shared";
  import { getEvent } from "../../api/events.js";
  import { getEventOrders, webhookRelay, type EventOrdersResponse } from "../../api/events.js";
  import { restorePodSeed } from "../../auth/pod-identity.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { navigate } from "../../router/router.svelte.js";
  import { onMount } from "svelte";

  interface Props {
    eventId: string;
  }

  let { eventId }: Props = $props();

  // State
  let event = $state<EventFeed | null>(null);
  let ordersResponse = $state<EventOrdersResponse | null>(null);
  let decryptedOrders = $state<Map<number, DecryptedOrder>>(new Map());
  let loading = $state(true);
  let decrypting = $state(false);
  let error = $state<string | null>(null);
  let decryptError = $state<string | null>(null);

  // Webhook state
  interface WebhookConfig {
    url: string;
    authHeaderName?: string;
    authHeaderValue?: string;
  }
  interface SentRecord {
    sentAt: string;
    statusCode: number;
    success: boolean;
  }

  let webhookConfig = $state<WebhookConfig | null>(null);
  let sentMap = $state<Record<string, SentRecord>>({});
  let sending = $state<Set<string>>(new Set());
  let showWebhookConfig = $state(false);
  let webhookFormUrl = $state("");
  let webhookFormAuthName = $state("Authorization");
  let webhookFormAuthValue = $state("");
  let bulkSending = $state<string | null>(null); // seriesId currently bulk-sending

  interface DecryptedOrder {
    fields?: Record<string, string>;
    seriesId?: string;
    claimerEmail?: string;
    claimerAddress?: string;
  }

  // ---------------------------------------------------------------------------
  // localStorage helpers
  // ---------------------------------------------------------------------------

  function loadWebhookConfig(): WebhookConfig | null {
    try {
      const raw = localStorage.getItem(`woco:webhook:${eventId}`);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function loadSentMap(): Record<string, SentRecord> {
    try {
      const raw = localStorage.getItem(`woco:webhook-sent:${eventId}`);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }

  function saveWebhookConfig() {
    const cfg: WebhookConfig = {
      url: webhookFormUrl.trim(),
      authHeaderName: webhookFormAuthName.trim() || undefined,
      authHeaderValue: webhookFormAuthValue || undefined,
    };
    if (!cfg.url) return;
    localStorage.setItem(`woco:webhook:${eventId}`, JSON.stringify(cfg));
    webhookConfig = cfg;
    showWebhookConfig = false;
  }

  function clearWebhookConfig() {
    localStorage.removeItem(`woco:webhook:${eventId}`);
    webhookConfig = null;
    webhookFormUrl = "";
    webhookFormAuthName = "Authorization";
    webhookFormAuthValue = "";
  }

  function persistSentMap() {
    localStorage.setItem(`woco:webhook-sent:${eventId}`, JSON.stringify(sentMap));
  }

  // ---------------------------------------------------------------------------
  // Grouping / CSV helpers
  // ---------------------------------------------------------------------------

  function groupBySeries(orders: OrderEntry[]): Map<string, OrderEntry[]> {
    const map = new Map<string, OrderEntry[]>();
    for (const order of orders) {
      const list = map.get(order.seriesId) ?? [];
      list.push(order);
      map.set(order.seriesId, list);
    }
    return map;
  }

  function escapeCSV(val: string): string {
    if (val.includes(",") || val.includes('"') || val.includes("\n")) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  }

  function downloadCSV(seriesName: string, seriesOrders: OrderEntry[], fields: OrderField[]) {
    const headers = ["Edition", "Claimer", "Email", "Claimed At", ...fields.map((f) => f.label)];
    const rows = seriesOrders.map((order) => {
      const dec = decryptedOrders.get(ordersResponse!.orders.indexOf(order));
      return [
        String(order.edition),
        order.claimerAddress.startsWith("email:") ? "" : order.claimerAddress,
        dec?.claimerEmail ?? "",
        new Date(order.claimedAt).toLocaleString(),
        ...fields.map((f) => dec?.fields?.[f.id] ?? ""),
      ];
    });

    const csv = [
      headers.map(escapeCSV).join(","),
      ...rows.map((r) => r.map(escapeCSV).join(",")),
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${seriesName.replace(/[^a-zA-Z0-9]/g, "_")}_orders.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---------------------------------------------------------------------------
  // Webhook send helpers
  // ---------------------------------------------------------------------------

  function orderKey(order: OrderEntry): string {
    return `${order.seriesId}:${order.edition}`;
  }

  function buildPayload(order: OrderEntry, dec: DecryptedOrder): Record<string, unknown> {
    // Map field IDs to human-readable labels
    const labeledFields: Record<string, string> = {};
    if (event?.orderFields && dec.fields) {
      for (const f of event.orderFields) {
        if (dec.fields[f.id] !== undefined) {
          labeledFields[f.label] = dec.fields[f.id];
        }
      }
    }

    return {
      event: event!.title,
      eventId,
      series: order.seriesName,
      edition: order.edition,
      claimerAddress: order.claimerAddress,
      ...(dec.claimerEmail ? { claimerEmail: dec.claimerEmail } : {}),
      claimedAt: order.claimedAt,
      fields: labeledFields,
    };
  }

  async function sendOne(order: OrderEntry, globalIdx: number) {
    if (!webhookConfig) return;
    const key = orderKey(order);
    const dec = decryptedOrders.get(globalIdx);
    if (!dec) return;

    sending = new Set([...sending, key]);
    try {
      const headers: Record<string, string> = {};
      if (webhookConfig.authHeaderName && webhookConfig.authHeaderValue) {
        headers[webhookConfig.authHeaderName] = webhookConfig.authHeaderValue;
      }

      const payload = buildPayload(order, dec);
      const result = await webhookRelay(eventId, webhookConfig.url, headers, payload);

      sentMap[key] = {
        sentAt: new Date().toISOString(),
        statusCode: result.status,
        success: result.status >= 200 && result.status < 300,
      };
      sentMap = { ...sentMap };
      persistSentMap();
    } catch (err) {
      sentMap[key] = {
        sentAt: new Date().toISOString(),
        statusCode: 0,
        success: false,
      };
      sentMap = { ...sentMap };
      persistSentMap();
    } finally {
      const next = new Set(sending);
      next.delete(key);
      sending = next;
    }
  }

  function unsentCount(seriesOrders: OrderEntry[]): number {
    return seriesOrders.filter((o) => {
      const key = orderKey(o);
      const globalIdx = ordersResponse!.orders.indexOf(o);
      return decryptedOrders.has(globalIdx) && !sentMap[key];
    }).length;
  }

  async function sendAllUnsent(seriesId: string, seriesOrders: OrderEntry[]) {
    bulkSending = seriesId;
    for (const order of seriesOrders) {
      const key = orderKey(order);
      const globalIdx = ordersResponse!.orders.indexOf(order);
      if (!decryptedOrders.has(globalIdx) || sentMap[key]) continue;
      await sendOne(order, globalIdx);
      // 200ms delay between sends
      await new Promise((r) => setTimeout(r, 200));
    }
    bulkSending = null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onMount(async () => {
    // Load webhook config from localStorage
    webhookConfig = loadWebhookConfig();
    sentMap = loadSentMap();
    if (webhookConfig) {
      webhookFormUrl = webhookConfig.url;
      webhookFormAuthName = webhookConfig.authHeaderName ?? "Authorization";
      webhookFormAuthValue = webhookConfig.authHeaderValue ?? "";
    }

    try {
      // Check auth — only need identity (isConnected), not session
      if (!auth.isConnected) {
        error = "Please sign in to view the dashboard";
        loading = false;
        return;
      }

      // Load event first (public, no auth needed)
      const ev = await getEvent(eventId);
      if (!ev) {
        error = "Event not found";
        loading = false;
        return;
      }

      // Verify organizer
      if (auth.parent?.toLowerCase() !== ev.creatorAddress.toLowerCase()) {
        error = "Only the event organizer can view this dashboard";
        loading = false;
        return;
      }

      // Load orders (authGet — will lazily trigger session delegation EIP-712 if needed)
      const ordersResp = await getEventOrders(eventId);

      event = ev;
      ordersResponse = ordersResp;
      loading = false;

      // Decrypt orders (only if some have encrypted data)
      if (ordersResp.orders.length === 0) return;

      const hasEncryptedOrders = ordersResp.orders.some((o) => !!o.encryptedOrder);
      if (!hasEncryptedOrders) return;

      decrypting = true;

      // Ensure POD identity exists (will trigger EIP-712 if needed after forget/reconnect)
      let podSeed = await restorePodSeed();
      if (!podSeed) {
        const pk = await auth.ensurePodIdentity();
        if (!pk) {
          decryptError = "POD identity derivation cancelled. Cannot decrypt orders.";
          decrypting = false;
          return;
        }
        podSeed = await restorePodSeed();
      }
      if (!podSeed) {
        decryptError = "POD identity not found. Please re-derive your identity.";
        decrypting = false;
        return;
      }

      const { privateKey } = deriveEncryptionKeypairFromPodSeed(podSeed);

      // Decrypt orders that have encrypted data (skip claims without order info)
      const results = await Promise.allSettled(
        ordersResp.orders.map(async (order, idx) => {
          if (!order.encryptedOrder) return { idx, data: {} as DecryptedOrder };
          const decrypted = await openJson<DecryptedOrder>(privateKey, order.encryptedOrder);
          return { idx, data: decrypted };
        }),
      );

      const newMap = new Map<number, DecryptedOrder>();
      let failCount = 0;
      for (const result of results) {
        if (result.status === "fulfilled") {
          newMap.set(result.value.idx, result.value.data);
        } else {
          failCount++;
        }
      }
      decryptedOrders = newMap;

      if (failCount > 0) {
        decryptError = `Failed to decrypt ${failCount} order(s)`;
      }
      decrypting = false;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load dashboard";
      loading = false;
      decrypting = false;
    }
  });
</script>

<div class="dashboard">
  <button class="back-link" onclick={() => navigate(`/event/${eventId}`)}>
    &larr; Back to event
  </button>

  {#if loading}
    <p class="status">Loading dashboard...</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if event && ordersResponse}
    <h1>Orders Dashboard</h1>
    <p class="subtitle">{event.title}</p>

    <!-- Webhook config panel -->
    <div class="webhook-section">
      <button
        class="webhook-toggle"
        onclick={() => (showWebhookConfig = !showWebhookConfig)}
      >
        Webhook {webhookConfig ? "(configured)" : "(not configured)"}
        <span class="chevron" class:open={showWebhookConfig}></span>
      </button>

      {#if showWebhookConfig}
        <div class="webhook-config">
          <label class="config-field">
            <span>Endpoint URL</span>
            <input
              type="url"
              placeholder="https://api.example.com/webhook"
              bind:value={webhookFormUrl}
            />
          </label>
          <label class="config-field">
            <span>Auth header name</span>
            <input
              type="text"
              placeholder="Authorization"
              bind:value={webhookFormAuthName}
            />
          </label>
          <label class="config-field">
            <span>Auth header value</span>
            <input
              type="password"
              placeholder="Bearer sk-..."
              bind:value={webhookFormAuthValue}
            />
          </label>
          <p class="config-hint">Credentials stored only in your browser.</p>
          <div class="config-actions">
            <button class="btn-save" onclick={saveWebhookConfig}>Save</button>
            {#if webhookConfig}
              <button class="btn-remove" onclick={clearWebhookConfig}>Remove</button>
            {/if}
          </div>
        </div>
      {/if}
    </div>

    {#if ordersResponse.orders.length === 0}
      <div class="empty-state">
        <p>No orders yet. Orders will appear here when attendees claim tickets with order data.</p>
      </div>
    {:else}
      {#if decrypting}
        <p class="status">Decrypting order data...</p>
      {/if}

      {#if decryptError}
        <p class="warning">{decryptError}</p>
      {/if}

      {@const grouped = groupBySeries(ordersResponse.orders)}
      {#each event.series as series}
        {@const seriesOrders = grouped.get(series.seriesId) ?? []}
        {#if seriesOrders.length > 0}
          <div class="series-section">
            <div class="series-header">
              <h2>{series.name}</h2>
              <span class="order-count">{seriesOrders.length} order{seriesOrders.length !== 1 ? "s" : ""}</span>
              {#if event.orderFields && decryptedOrders.size > 0}
                <button
                  class="csv-btn"
                  onclick={() => downloadCSV(series.name, seriesOrders, event!.orderFields!)}
                >
                  Export CSV
                </button>
              {/if}
              {#if webhookConfig && decryptedOrders.size > 0}
                {@const unsent = unsentCount(seriesOrders)}
                {#if unsent > 0}
                  <button
                    class="bulk-send-btn"
                    disabled={bulkSending === series.seriesId}
                    onclick={() => sendAllUnsent(series.seriesId, seriesOrders)}
                  >
                    {bulkSending === series.seriesId ? "Sending..." : `Send ${unsent} unsent`}
                  </button>
                {/if}
              {/if}
            </div>

            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Edition</th>
                    <th>Claimer</th>
                    <th>Claimed At</th>
                    {#if event.orderFields}
                      {#each event.orderFields as field}
                        <th>{field.label}</th>
                      {/each}
                    {/if}
                    <th>Webhook</th>
                  </tr>
                </thead>
                <tbody>
                  {#each seriesOrders as order}
                    {@const globalIdx = ordersResponse!.orders.indexOf(order)}
                    {@const dec = decryptedOrders.get(globalIdx)}
                    {@const key = orderKey(order)}
                    {@const sent = sentMap[key]}
                    {@const isSending = sending.has(key)}
                    <tr>
                      <td>#{order.edition}</td>
                      <td class="address" title={order.claimerAddress}>
                        {#if order.claimerAddress.startsWith("email:")}
                          {#if dec?.claimerEmail}
                            <span class="claim-email">{dec.claimerEmail}</span>
                          {:else}
                            <span class="claim-type">Email claim</span>
                          {/if}
                        {:else}
                          {order.claimerAddress.slice(0, 6)}...{order.claimerAddress.slice(-4)}
                        {/if}
                      </td>
                      <td>{new Date(order.claimedAt).toLocaleString()}</td>
                      {#if event.orderFields}
                        {#each event.orderFields as field}
                          <td>{dec?.fields?.[field.id] ?? (decrypting ? "..." : "-")}</td>
                        {/each}
                      {/if}
                      <td class="webhook-cell">
                        {#if isSending}
                          <span class="badge badge-sending">Sending...</span>
                        {:else if sent?.success}
                          <span class="badge badge-sent" title="Sent {new Date(sent.sentAt).toLocaleString()}">Sent</span>
                        {:else if sent && !sent.success}
                          <button
                            class="badge badge-failed"
                            title="Failed ({sent.statusCode}) — click to retry"
                            onclick={() => sendOne(order, globalIdx)}
                          >Failed</button>
                        {:else if webhookConfig && dec}
                          <button
                            class="btn-send"
                            onclick={() => sendOne(order, globalIdx)}
                          >Send</button>
                        {:else if !webhookConfig}
                          <span class="badge badge-none">No webhook</span>
                        {:else}
                          <span class="badge badge-none">-</span>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        {/if}
      {/each}
    {/if}
  {/if}
</div>

<style>
  .dashboard {
    max-width: 960px;
    margin: 0 auto;
  }

  .back-link {
    color: var(--text-muted);
    font-size: 0.875rem;
    margin-bottom: 1.5rem;
    display: inline-block;
    transition: color var(--transition);
  }

  .back-link:hover {
    color: var(--accent-text);
  }

  h1 {
    color: var(--text);
    margin: 0 0 0.25rem;
    font-size: 1.75rem;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .subtitle {
    color: var(--text-muted);
    font-size: 0.9375rem;
    margin: 0 0 1.5rem;
  }

  /* Webhook config panel */
  .webhook-section {
    margin-bottom: 1.5rem;
  }

  .webhook-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text-secondary);
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    width: 100%;
    text-align: left;
    transition: all var(--transition);
  }

  .webhook-toggle:hover {
    border-color: var(--accent);
    color: var(--accent-text);
  }

  .chevron {
    margin-left: auto;
    display: inline-block;
    width: 0;
    height: 0;
    border-left: 4px solid transparent;
    border-right: 4px solid transparent;
    border-top: 5px solid currentColor;
    transition: transform 0.2s;
  }

  .chevron.open {
    transform: rotate(180deg);
  }

  .webhook-config {
    padding: 1rem;
    border: 1px solid var(--border);
    border-top: none;
    border-radius: 0 0 var(--radius-sm) var(--radius-sm);
  }

  .config-field {
    display: block;
    margin-bottom: 0.75rem;
  }

  .config-field span {
    display: block;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 0.25rem;
  }

  .config-field input {
    width: 100%;
    padding: 0.5rem 0.625rem;
    font-size: 0.8125rem;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .config-field input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .config-hint {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin: 0 0 0.75rem;
  }

  .config-actions {
    display: flex;
    gap: 0.5rem;
  }

  .btn-save {
    padding: 0.375rem 1rem;
    font-size: 0.8125rem;
    font-weight: 500;
    background: var(--accent);
    color: #fff;
    border-radius: var(--radius-sm);
    transition: opacity var(--transition);
  }

  .btn-save:hover {
    opacity: 0.85;
  }

  .btn-remove {
    padding: 0.375rem 1rem;
    font-size: 0.8125rem;
    font-weight: 500;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    transition: all var(--transition);
  }

  .btn-remove:hover {
    border-color: var(--error);
    color: var(--error);
  }

  /* Series sections */
  .empty-state {
    text-align: center;
    padding: 3rem 1rem;
    color: var(--text-muted);
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
  }

  .series-section {
    margin-bottom: 2rem;
  }

  .series-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
    flex-wrap: wrap;
  }

  .series-header h2 {
    color: var(--text);
    font-size: 1.125rem;
    font-weight: 600;
    margin: 0;
  }

  .order-count {
    color: var(--text-muted);
    font-size: 0.8125rem;
  }

  .csv-btn {
    margin-left: auto;
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
    font-weight: 500;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    transition: all var(--transition);
  }

  .csv-btn:hover {
    border-color: var(--accent);
    color: var(--accent-text);
  }

  .bulk-send-btn {
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
    font-weight: 500;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    color: var(--accent-text);
    transition: all var(--transition);
  }

  .bulk-send-btn:hover:not(:disabled) {
    background: var(--accent);
    color: #fff;
  }

  .bulk-send-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  /* Table */
  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
  }

  th {
    text-align: left;
    padding: 0.625rem 0.75rem;
    color: var(--text-muted);
    font-weight: 500;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }

  td {
    padding: 0.5rem 0.75rem;
    color: var(--text-secondary);
    border-bottom: 1px solid var(--border);
  }

  tr:last-child td {
    border-bottom: none;
  }

  tr:hover td {
    background: var(--accent-subtle);
  }

  .address {
    font-family: monospace;
    font-size: 0.75rem;
  }

  .claim-email {
    font-family: inherit;
    color: var(--accent-text);
  }

  .claim-type {
    font-family: inherit;
    color: var(--text-muted);
    font-style: italic;
  }

  /* Webhook column */
  .webhook-cell {
    white-space: nowrap;
  }

  .badge {
    display: inline-block;
    padding: 0.2rem 0.5rem;
    font-size: 0.6875rem;
    font-weight: 600;
    border-radius: 9999px;
    letter-spacing: 0.02em;
  }

  .badge-sent {
    background: rgba(34, 197, 94, 0.15);
    color: #22c55e;
  }

  .badge-sending {
    background: rgba(124, 108, 240, 0.15);
    color: var(--accent-text);
  }

  .badge-failed {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
    cursor: pointer;
    border: none;
    font-size: 0.6875rem;
    font-weight: 600;
    padding: 0.2rem 0.5rem;
    border-radius: 9999px;
  }

  .badge-failed:hover {
    background: rgba(239, 68, 68, 0.3);
  }

  .badge-none {
    color: var(--text-muted);
    font-weight: 400;
  }

  .btn-send {
    padding: 0.2rem 0.625rem;
    font-size: 0.75rem;
    font-weight: 500;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    color: var(--accent-text);
    transition: all var(--transition);
  }

  .btn-send:hover {
    background: var(--accent);
    color: #fff;
  }

  /* Status / error */
  .status {
    text-align: center;
    color: var(--text-muted);
    padding: 3rem 0;
  }

  .error {
    text-align: center;
    color: var(--error);
    padding: 3rem 0;
  }

  .warning {
    color: var(--text-muted);
    font-size: 0.8125rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    margin-bottom: 1rem;
  }
</style>
