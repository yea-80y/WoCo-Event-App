<script lang="ts">
  import type { EventFeed, OrderEntry, SealedBox, OrderField } from "@woco/shared";
  import { deriveEncryptionKeypairFromPodSeed, openJson } from "@woco/shared";
  import { getEvent } from "../../api/events.js";
  import { getEventOrders, webhookRelay, getPendingClaims, approvePendingClaim, rejectPendingClaim, sendBroadcast, type EventOrdersResponse, type PendingClaimEntry, type BroadcastResponse } from "../../api/events.js";
  import { restorePodSeed } from "../../auth/pod-identity.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { navigate } from "../../router/router.svelte.js";
  import { onMount } from "svelte";
  import StripeConnect from "./StripeConnect.svelte";

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

  // Approval tab state
  let activeTab = $state<"orders" | "approvals" | "broadcast" | "payments">("orders");
  let pendingEntries = $state<PendingClaimEntry[]>([]);
  let decryptedPending = $state<Map<string, DecryptedOrder>>(new Map()); // keyed by pendingId
  let approvingId = $state<string | null>(null);
  let rejectingId = $state<string | null>(null);

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

  // Broadcast state
  let broadcastSubject = $state("");
  let broadcastBody = $state("");
  let broadcastSending = $state(false);
  let broadcastResult = $state<BroadcastResponse | null>(null);
  let broadcastError = $state<string | null>(null);
  let broadcastSeriesFilter = $state<string>("all");
  let showPreview = $state(false);
  let showRecipientList = $state(false);

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
    const headers = ["Edition", "Claimer", "Email", "Paid via", "Claimed At", ...fields.map((f) => f.label)];
    const rows = seriesOrders.map((order) => {
      const dec = decryptedOrders.get(ordersResponse!.orders.indexOf(order));
      return [
        String(order.edition),
        order.claimerAddress.startsWith("email:") ? "" : order.claimerAddress,
        dec?.claimerEmail ?? "",
        order.via ?? "",
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
  // Broadcast helpers
  // ---------------------------------------------------------------------------

  function getEmailRecipients(seriesFilter: string = "all"): Array<{ email: string; name?: string; seriesName?: string }> {
    const recipients: Array<{ email: string; name?: string; seriesName?: string }> = [];
    const seen = new Set<string>();
    for (const [idx, dec] of decryptedOrders) {
      const order = ordersResponse?.orders[idx];
      if (seriesFilter !== "all" && order?.seriesId !== seriesFilter) continue;
      if (dec.claimerEmail && !seen.has(dec.claimerEmail.toLowerCase())) {
        seen.add(dec.claimerEmail.toLowerCase());
        recipients.push({ email: dec.claimerEmail, seriesName: order?.seriesName });
      }
    }
    return recipients;
  }

  function wrapHtmlEmail(body: string, eventTitle: string): string {
    const escaped = body.replace(/\n/g, "<br>");
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #e0e0e0; background: #1a1a2e; padding: 2rem;">
  <div style="max-width: 600px; margin: 0 auto; background: #16213e; border-radius: 12px; padding: 2rem;">
    <h2 style="color: #fff; margin: 0 0 1rem;">${eventTitle}</h2>
    <div style="color: #c0c0c0; line-height: 1.6; font-size: 15px;">${escaped}</div>
    <hr style="border: none; border-top: 1px solid #2a2a4a; margin: 2rem 0 1rem;">
    <p style="font-size: 12px; color: #666;">Sent via <a href="https://woco.eth.limo" style="color: #7c6cf0;">WoCo</a></p>
  </div>
</body></html>`;
  }

  async function handleSendBroadcast() {
    if (!event || broadcastSending) return;
    broadcastError = null;
    broadcastResult = null;

    const recipients = getEmailRecipients(broadcastSeriesFilter);
    if (recipients.length === 0) {
      broadcastError = "No email recipients found. Only attendees who claimed with an email can receive broadcasts.";
      return;
    }

    if (!broadcastSubject.trim()) {
      broadcastError = "Subject is required.";
      return;
    }

    if (!broadcastBody.trim()) {
      broadcastError = "Message body is required.";
      return;
    }

    const seriesLabel = broadcastSeriesFilter === "all"
      ? "all series"
      : event.series.find((s) => s.seriesId === broadcastSeriesFilter)?.name ?? "selected series";

    if (!confirm(`Send "${broadcastSubject.trim()}" to ${recipients.length} recipient${recipients.length !== 1 ? "s" : ""} (${seriesLabel})?`)) {
      return;
    }

    broadcastSending = true;
    try {
      const htmlBody = wrapHtmlEmail(broadcastBody.trim(), event.title);
      broadcastResult = await sendBroadcast(eventId, broadcastSubject.trim(), htmlBody, recipients);
      if (broadcastResult.sentCount > 0) {
        broadcastSubject = "";
        broadcastBody = "";
        showPreview = false;
      }
    } catch (err) {
      broadcastError = err instanceof Error ? err.message : "Failed to send broadcast";
    } finally {
      broadcastSending = false;
    }
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

      // Load orders + pending claims in parallel
      const [ordersResp, pending] = await Promise.all([
        getEventOrders(eventId),
        getPendingClaims(eventId).catch(() => [] as PendingClaimEntry[]),
      ]);

      event = ev;
      ordersResponse = ordersResp;
      pendingEntries = pending;
      loading = false;

      // Switch to approvals tab automatically if there are pending entries
      if (pending.length > 0 && ordersResp.orders.length === 0) {
        activeTab = "approvals";
      }

      // Determine if we have any encrypted data to decrypt (orders or pending)
      const hasEncryptedOrders = ordersResp.orders.some((o) => !!o.encryptedOrder);
      const hasEncryptedPending = pending.some((p) => !!p.encryptedOrder);
      if (!hasEncryptedOrders && !hasEncryptedPending) return;

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

      // Decrypt orders
      if (hasEncryptedOrders) {
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
      }

      // Decrypt pending claim orders
      if (hasEncryptedPending) {
        const pendingResults = await Promise.allSettled(
          pending.map(async (entry) => {
            if (!entry.encryptedOrder) return { pendingId: entry.pendingId, data: {} as DecryptedOrder };
            const decrypted = await openJson<DecryptedOrder>(privateKey, entry.encryptedOrder);
            return { pendingId: entry.pendingId, data: decrypted };
          }),
        );
        const newPendingMap = new Map<string, DecryptedOrder>();
        for (const result of pendingResults) {
          if (result.status === "fulfilled") {
            newPendingMap.set(result.value.pendingId, result.value.data);
          }
        }
        decryptedPending = newPendingMap;
      }

      decrypting = false;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load dashboard";
      loading = false;
      decrypting = false;
    }
  });

  // ---------------------------------------------------------------------------
  // Approve / reject handlers
  // ---------------------------------------------------------------------------

  async function handleApprove(entry: PendingClaimEntry) {
    if (approvingId) return;
    approvingId = entry.pendingId;
    try {
      const result = await approvePendingClaim(eventId, entry.seriesId, entry.pendingId);
      if (!result.ok) {
        alert(`Failed to approve: ${result.error}`);
        return;
      }
      // Move to orders tab: remove from pending, reload orders
      pendingEntries = pendingEntries.filter((e) => e.pendingId !== entry.pendingId);
      const ordersResp = await getEventOrders(eventId);
      ordersResponse = ordersResp;
      if (pendingEntries.length === 0) activeTab = "orders";
    } catch (e) {
      alert(`Approve failed: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      approvingId = null;
    }
  }

  async function handleReject(entry: PendingClaimEntry) {
    if (rejectingId) return;
    const reason = prompt("Rejection reason (optional):");
    if (reason === null) return; // cancelled
    rejectingId = entry.pendingId;
    try {
      const result = await rejectPendingClaim(eventId, entry.seriesId, entry.pendingId, reason || undefined);
      if (!result.ok) {
        alert(`Failed to reject: ${result.error}`);
        return;
      }
      pendingEntries = pendingEntries.filter((e) => e.pendingId !== entry.pendingId);
      if (pendingEntries.length === 0) activeTab = "orders";
    } catch (e) {
      alert(`Reject failed: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      rejectingId = null;
    }
  }
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

    <!-- Tab bar -->
    <div class="tab-bar">
      <button
        class="tab-btn"
        class:active={activeTab === "orders"}
        onclick={() => (activeTab = "orders")}
      >
        Orders
      </button>
      <button
        class="tab-btn"
        class:active={activeTab === "approvals"}
        onclick={() => (activeTab = "approvals")}
      >
        Approvals
        {#if pendingEntries.length > 0}
          <span class="tab-badge">{pendingEntries.length}</span>
        {/if}
      </button>
      <button
        class="tab-btn"
        class:active={activeTab === "broadcast"}
        onclick={() => (activeTab = "broadcast")}
      >
        Broadcast
      </button>
      <button
        class="tab-btn"
        class:active={activeTab === "payments"}
        onclick={() => (activeTab = "payments")}
      >
        Payments
      </button>
    </div>

    {#if activeTab === "payments"}
      <!-- Payments tab — Stripe Connect onboarding + status -->
      <div class="payments-section">
        <StripeConnect />
      </div>
    {:else if activeTab === "broadcast"}
      <!-- Broadcast tab -->
      {@const emailRecipients = getEmailRecipients(broadcastSeriesFilter)}
      <div class="broadcast-section">

        {#if decryptedOrders.size === 0 && ordersResponse && ordersResponse.orders.length > 0}
          <div class="broadcast-notice">
            Orders need to be decrypted before you can send broadcasts.
            Switch to the Orders tab to trigger decryption, then come back here.
          </div>
        {:else if ordersResponse && ordersResponse.orders.length === 0}
          <div class="empty-state">
            <p>No attendees yet. Broadcasts will be available once people claim tickets with an email address.</p>
          </div>
        {:else}

          <!-- Series filter + recipient count -->
          <div class="broadcast-toolbar">
            <div class="broadcast-filter">
              <label class="filter-label" for="series-filter">Audience</label>
              <select id="series-filter" class="filter-select" bind:value={broadcastSeriesFilter}>
                <option value="all">All series ({getEmailRecipients("all").length} emails)</option>
                {#if event}
                  {#each event.series as series}
                    {@const count = getEmailRecipients(series.seriesId).length}
                    {#if count > 0}
                      <option value={series.seriesId}>{series.name} ({count})</option>
                    {/if}
                  {/each}
                {/if}
              </select>
            </div>

            <button
              class="btn-toggle-recipients"
              onclick={() => (showRecipientList = !showRecipientList)}
              disabled={emailRecipients.length === 0}
            >
              {emailRecipients.length} recipient{emailRecipients.length !== 1 ? "s" : ""}
              <span class="chevron-sm" class:open={showRecipientList}></span>
            </button>
          </div>

          <!-- Collapsible recipient list -->
          {#if showRecipientList && emailRecipients.length > 0}
            <div class="recipient-list">
              {#each emailRecipients as r}
                <div class="recipient-row">
                  <span class="recipient-email">{r.email}</span>
                  {#if r.seriesName}
                    <span class="recipient-series">{r.seriesName}</span>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}

          <!-- Compose form -->
          <div class="broadcast-compose">
            <label class="broadcast-field">
              <span>Subject</span>
              <input
                type="text"
                placeholder="e.g. Important update about the event"
                bind:value={broadcastSubject}
                maxlength="200"
              />
            </label>

            <label class="broadcast-field">
              <span>Message</span>
              <textarea
                placeholder="Write your message here. Line breaks will be preserved in the email."
                bind:value={broadcastBody}
                rows="8"
              ></textarea>
            </label>
          </div>

          <!-- Preview toggle -->
          {#if broadcastBody.trim()}
            <button
              class="btn-preview-toggle"
              onclick={() => (showPreview = !showPreview)}
            >
              {showPreview ? "Hide preview" : "Preview email"}
            </button>

            {#if showPreview && event}
              <div class="email-preview">
                <div class="preview-header">
                  <div class="preview-meta">
                    <span class="preview-label">From:</span>
                    <span>"{event.title}" &lt;events@woco-net.com&gt;</span>
                  </div>
                  <div class="preview-meta">
                    <span class="preview-label">Subject:</span>
                    <span>{broadcastSubject || "(no subject)"}</span>
                  </div>
                  <div class="preview-meta">
                    <span class="preview-label">To:</span>
                    <span>{emailRecipients.length} recipient{emailRecipients.length !== 1 ? "s" : ""} (sent individually)</span>
                  </div>
                </div>
                <div class="preview-body">
                  {@html wrapHtmlEmail(broadcastBody.trim(), event.title)}
                </div>
              </div>
            {/if}
          {/if}

          <!-- Feedback -->
          {#if broadcastError}
            <p class="broadcast-error">{broadcastError}</p>
          {/if}

          {#if broadcastResult}
            <div class="broadcast-result" class:has-failures={broadcastResult.failedCount > 0}>
              Sent to {broadcastResult.sentCount} of {broadcastResult.totalRecipients} recipient{broadcastResult.totalRecipients !== 1 ? "s" : ""}.
              {#if broadcastResult.failedCount > 0}
                <br>{broadcastResult.failedCount} failed.
              {/if}
            </div>
          {/if}

          <!-- Send button -->
          <div class="broadcast-actions">
            <button
              class="btn-broadcast"
              disabled={broadcastSending || emailRecipients.length === 0 || !broadcastSubject.trim() || !broadcastBody.trim()}
              onclick={handleSendBroadcast}
            >
              {#if broadcastSending}
                Sending...
              {:else}
                Send to {emailRecipients.length} recipient{emailRecipients.length !== 1 ? "s" : ""}
              {/if}
            </button>
            <span class="broadcast-rate-hint">Max 5 broadcasts per hour</span>
          </div>

        {/if}
      </div>

    {:else if activeTab === "approvals"}
      <!-- Approvals tab -->
      {#if pendingEntries.length === 0}
        <div class="empty-state">
          <p>No pending approval requests.</p>
        </div>
      {:else}
        {#if decrypting}
          <p class="status">Decrypting order data...</p>
        {/if}
        {#if decryptError}
          <p class="warning">{decryptError}</p>
        {/if}
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Series</th>
                <th>Claimer</th>
                <th>Requested At</th>
                {#if event.orderFields}
                  {#each event.orderFields as field}
                    <th>{field.label}</th>
                  {/each}
                {/if}
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {#each pendingEntries as entry}
                {@const dec = decryptedPending.get(entry.pendingId)}
                {@const isApproving = approvingId === entry.pendingId}
                {@const isRejecting = rejectingId === entry.pendingId}
                <tr>
                  <td>{entry.seriesName}</td>
                  <td class="address" title={entry.claimerKey}>
                    {#if entry.claimerKey.startsWith("email:")}
                      {#if dec?.claimerEmail}
                        <span class="claim-email">{dec.claimerEmail}</span>
                      {:else}
                        <span class="claim-type">Email claim</span>
                      {/if}
                    {:else}
                      {entry.claimerKey.slice(0, 6)}...{entry.claimerKey.slice(-4)}
                    {/if}
                  </td>
                  <td>{new Date(entry.requestedAt).toLocaleString()}</td>
                  {#if event.orderFields}
                    {#each event.orderFields as field}
                      <td>{dec?.fields?.[field.id] ?? (decrypting ? "..." : "-")}</td>
                    {/each}
                  {/if}
                  <td class="action-cell">
                    <button
                      class="btn-approve"
                      disabled={isApproving || isRejecting || !!approvingId || !!rejectingId}
                      onclick={() => handleApprove(entry)}
                    >
                      {isApproving ? "Approving..." : "Approve"}
                    </button>
                    <button
                      class="btn-reject"
                      disabled={isApproving || isRejecting || !!approvingId || !!rejectingId}
                      onclick={() => handleReject(entry)}
                    >
                      {isRejecting ? "Rejecting..." : "Reject"}
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {:else}

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

    <!-- ── Sales overview (organiser-only) ────────────────────────────────────
         Replaces the customer-facing "X / Y available" line on the event
         page. Shows every series with sold / total / remaining so the
         organiser sees real-time stock at a glance, including series that
         haven't sold yet. ─────────────────────────────────────────────── -->
    {@const _grouped = groupBySeries(ordersResponse.orders)}
    {@const _totalSold = ordersResponse.orders.length}
    {@const _totalSupply = event.series.reduce((acc, s) => acc + s.totalSupply, 0)}
    <div class="sales-panel">
      <div class="sales-summary">
        <div class="sales-stat">
          <span class="sales-stat-label">Sold</span>
          <span class="sales-stat-value">{_totalSold}</span>
        </div>
        <div class="sales-stat">
          <span class="sales-stat-label">Remaining</span>
          <span class="sales-stat-value">{Math.max(0, _totalSupply - _totalSold)}</span>
        </div>
        <div class="sales-stat">
          <span class="sales-stat-label">Total</span>
          <span class="sales-stat-value">{_totalSupply}</span>
        </div>
      </div>
      <table class="sales-table">
        <thead>
          <tr>
            <th>Ticket</th>
            <th class="num">Sold</th>
            <th class="num">Remaining</th>
            <th class="num">Total</th>
            <th class="num">% sold</th>
          </tr>
        </thead>
        <tbody>
          {#each event.series as series}
            {@const sold = (_grouped.get(series.seriesId) ?? []).length}
            {@const remaining = Math.max(0, series.totalSupply - sold)}
            {@const pct = series.totalSupply > 0 ? Math.round((sold / series.totalSupply) * 100) : 0}
            <tr>
              <td>{series.name}</td>
              <td class="num">{sold}</td>
              <td class="num">{remaining}</td>
              <td class="num">{series.totalSupply}</td>
              <td class="num">{pct}%</td>
            </tr>
          {/each}
        </tbody>
      </table>
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
          {@const remaining = Math.max(0, series.totalSupply - seriesOrders.length)}
          <div class="series-section">
            <div class="series-header">
              <h2>{series.name}</h2>
              <span class="order-count">
                {seriesOrders.length} / {series.totalSupply} sold · {remaining} remaining
              </span>
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
                    <th>Paid via</th>
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
                      <td>
                        {#if order.via === "stripe"}
                          <span class="via-badge via-badge--stripe">Card</span>
                        {:else if order.via === "crypto"}
                          <span class="via-badge via-badge--crypto">Crypto</span>
                        {:else if order.via === "free"}
                          <span class="via-badge via-badge--free">Free</span>
                        {:else}
                          <span class="via-badge via-badge--unknown">—</span>
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

    {/if} <!-- end {:else} orders tab -->
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

  /* Sales overview */
  .sales-panel {
    margin-bottom: 2rem;
    padding: 1rem 1.25rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-card, transparent);
  }
  .sales-summary {
    display: flex;
    gap: 1.5rem;
    flex-wrap: wrap;
    padding-bottom: 0.875rem;
    margin-bottom: 0.875rem;
    border-bottom: 1px solid var(--border);
  }
  .sales-stat {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .sales-stat-label {
    font-size: 0.6875rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .sales-stat-value {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text);
  }
  .sales-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
  }
  .sales-table th,
  .sales-table td {
    padding: 0.5rem 0.625rem;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  .sales-table th {
    color: var(--text-muted);
    font-weight: 500;
    font-size: 0.75rem;
  }
  .sales-table tr:last-child td { border-bottom: 0; }
  .sales-table .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
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

  .via-badge {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    font-size: 0.6875rem;
    font-weight: 600;
    border-radius: 9999px;
    letter-spacing: 0.02em;
    border: 1px solid currentColor;
  }
  .via-badge--stripe { color: #635bff; background: rgba(99, 91, 255, 0.1); }
  .via-badge--crypto { color: #f59e0b; background: rgba(245, 158, 11, 0.1); }
  .via-badge--free   { color: var(--text-muted); background: rgba(125, 125, 125, 0.1); }
  .via-badge--unknown { color: var(--text-muted); border-color: transparent; }

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

  /* Tab bar */
  .tab-bar {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
    margin-bottom: 1.5rem;
  }

  .tab-btn {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.625rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text-muted);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: color var(--transition), border-color var(--transition);
  }

  .tab-btn:hover {
    color: var(--text-secondary);
  }

  .tab-btn.active {
    color: var(--accent-text);
    border-bottom-color: var(--accent);
  }

  .tab-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 0.375rem;
    font-size: 0.6875rem;
    font-weight: 700;
    background: #d97706;
    color: #fff;
    border-radius: 9999px;
  }

  /* Approval action buttons */
  .action-cell {
    white-space: nowrap;
    display: flex;
    gap: 0.375rem;
  }

  .btn-approve {
    padding: 0.25rem 0.625rem;
    font-size: 0.75rem;
    font-weight: 500;
    background: rgba(16, 185, 129, 0.15);
    color: #10b981;
    border-radius: var(--radius-sm);
    transition: background var(--transition);
  }

  .btn-approve:hover:not(:disabled) {
    background: rgba(16, 185, 129, 0.3);
  }

  .btn-approve:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn-reject {
    padding: 0.25rem 0.625rem;
    font-size: 0.75rem;
    font-weight: 500;
    background: rgba(239, 68, 68, 0.12);
    color: #ef4444;
    border-radius: var(--radius-sm);
    transition: background var(--transition);
  }

  .btn-reject:hover:not(:disabled) {
    background: rgba(239, 68, 68, 0.25);
  }

  .btn-reject:disabled {
    opacity: 0.4;
    cursor: not-allowed;
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

  /* Broadcast tab */
  .broadcast-section {
    max-width: 680px;
  }

  .broadcast-notice {
    font-size: 0.875rem;
    color: var(--text-muted);
    padding: 1.25rem;
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    text-align: center;
    line-height: 1.6;
  }

  .broadcast-toolbar {
    display: flex;
    align-items: flex-end;
    gap: 0.75rem;
    margin-bottom: 1.25rem;
    flex-wrap: wrap;
  }

  .broadcast-filter {
    flex: 1;
    min-width: 180px;
  }

  .filter-label {
    display: block;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 0.25rem;
  }

  .filter-select {
    width: 100%;
    padding: 0.5rem 0.625rem;
    font-size: 0.8125rem;
    color: var(--text);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: border-color var(--transition);
  }

  .filter-select:focus {
    outline: none;
    border-color: var(--accent);
  }

  .btn-toggle-recipients {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.75rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--accent-text);
    background: var(--accent-subtle);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    transition: all var(--transition);
    white-space: nowrap;
  }

  .btn-toggle-recipients:hover:not(:disabled) {
    border-color: var(--accent);
  }

  .btn-toggle-recipients:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .chevron-sm {
    display: inline-block;
    width: 0;
    height: 0;
    border-left: 3px solid transparent;
    border-right: 3px solid transparent;
    border-top: 4px solid currentColor;
    transition: transform 0.2s;
  }

  .chevron-sm.open {
    transform: rotate(180deg);
  }

  .recipient-list {
    max-height: 200px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    margin-bottom: 1.25rem;
    background: var(--bg-surface);
  }

  .recipient-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
    border-bottom: 1px solid var(--border);
  }

  .recipient-row:last-child {
    border-bottom: none;
  }

  .recipient-email {
    color: var(--text-secondary);
  }

  .recipient-series {
    font-size: 0.6875rem;
    color: var(--text-muted);
    padding: 0.125rem 0.5rem;
    background: var(--accent-subtle);
    border-radius: 9999px;
  }

  .broadcast-compose {
    margin-bottom: 0.75rem;
  }

  .broadcast-field {
    display: block;
    margin-bottom: 1rem;
  }

  .broadcast-field span {
    display: block;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 0.25rem;
  }

  .broadcast-field input,
  .broadcast-field textarea {
    width: 100%;
    padding: 0.625rem 0.75rem;
    font-size: 0.875rem;
    color: var(--text);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-family: inherit;
    resize: vertical;
    transition: border-color var(--transition);
  }

  .broadcast-field input:focus,
  .broadcast-field textarea:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-subtle);
  }

  /* Preview */
  .btn-preview-toggle {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--accent-text);
    padding: 0;
    margin-bottom: 0.75rem;
    transition: opacity var(--transition);
  }

  .btn-preview-toggle:hover {
    opacity: 0.75;
  }

  .email-preview {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    margin-bottom: 1.25rem;
  }

  .preview-header {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
  }

  .preview-meta {
    font-size: 0.75rem;
    color: var(--text-secondary);
    line-height: 1.6;
  }

  .preview-label {
    display: inline-block;
    width: 4rem;
    font-weight: 500;
    color: var(--text-muted);
  }

  .preview-body {
    padding: 0;
    background: #1a1a2e;
    border-radius: 0 0 var(--radius-md) var(--radius-md);
  }

  .preview-body :global(*) {
    max-width: 100%;
  }

  /* Feedback */
  .broadcast-error {
    font-size: 0.8125rem;
    color: var(--error);
    margin: 0 0 1rem;
  }

  .broadcast-result {
    font-size: 0.875rem;
    color: #22c55e;
    padding: 0.75rem 1rem;
    background: rgba(34, 197, 94, 0.1);
    border: 1px solid rgba(34, 197, 94, 0.2);
    border-radius: var(--radius-sm);
    margin-bottom: 1rem;
  }

  .broadcast-result.has-failures {
    color: #d97706;
    background: rgba(217, 119, 6, 0.1);
    border-color: rgba(217, 119, 6, 0.2);
  }

  .broadcast-actions {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .btn-broadcast {
    padding: 0.625rem 1.5rem;
    font-size: 0.875rem;
    font-weight: 600;
    background: var(--accent);
    color: #fff;
    border-radius: var(--radius-sm);
    transition: all var(--transition);
  }

  .btn-broadcast:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .btn-broadcast:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .broadcast-rate-hint {
    font-size: 0.75rem;
    color: var(--text-muted);
  }
</style>
