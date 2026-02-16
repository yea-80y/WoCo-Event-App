<script lang="ts">
  import type { EventFeed, OrderEntry, SealedBox, OrderField } from "@woco/shared";
  import { deriveEncryptionKeypairFromPodSeed, openJson } from "@woco/shared";
  import { getEvent } from "../../api/events.js";
  import { getEventOrders, type EventOrdersResponse } from "../../api/events.js";
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
  let decryptedOrders = $state<Map<number, Record<string, string>>>(new Map());
  let loading = $state(true);
  let decrypting = $state(false);
  let error = $state<string | null>(null);
  let decryptError = $state<string | null>(null);

  interface DecryptedOrder {
    fields: Record<string, string>;
    seriesId: string;
  }

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
    const headers = ["Edition", "Claimer", "Claimed At", ...fields.map((f) => f.label)];
    const rows = seriesOrders.map((order, idx) => {
      const dec = decryptedOrders.get(idx) ?? decryptedOrders.get(
        ordersResponse!.orders.indexOf(order)
      );
      return [
        String(order.edition),
        order.claimerAddress,
        new Date(order.claimedAt).toLocaleString(),
        ...fields.map((f) => dec?.[f.id] ?? ""),
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

  onMount(async () => {
    try {
      // Check auth
      if (!auth.isAuthenticated) {
        error = "Please sign in to view the dashboard";
        loading = false;
        return;
      }

      // Load event + orders in parallel
      const [ev, ordersResp] = await Promise.all([
        getEvent(eventId),
        getEventOrders(eventId),
      ]);

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

      event = ev;
      ordersResponse = ordersResp;
      loading = false;

      // Decrypt orders
      if (ordersResp.orders.length === 0) return;

      decrypting = true;
      const podSeed = await restorePodSeed();
      if (!podSeed) {
        decryptError = "POD identity not found. Please re-derive your identity.";
        decrypting = false;
        return;
      }

      const { privateKey } = deriveEncryptionKeypairFromPodSeed(podSeed);

      // Decrypt all orders in parallel
      const results = await Promise.allSettled(
        ordersResp.orders.map(async (order, idx) => {
          const decrypted = await openJson<DecryptedOrder>(privateKey, order.encryptedOrder);
          return { idx, fields: decrypted.fields };
        }),
      );

      const newMap = new Map<number, Record<string, string>>();
      let failCount = 0;
      for (const result of results) {
        if (result.status === "fulfilled") {
          newMap.set(result.value.idx, result.value.fields);
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
                  </tr>
                </thead>
                <tbody>
                  {#each seriesOrders as order}
                    {@const globalIdx = ordersResponse!.orders.indexOf(order)}
                    {@const dec = decryptedOrders.get(globalIdx)}
                    <tr>
                      <td>#{order.edition}</td>
                      <td class="address" title={order.claimerAddress}>
                        {order.claimerAddress.slice(0, 6)}...{order.claimerAddress.slice(-4)}
                      </td>
                      <td>{new Date(order.claimedAt).toLocaleString()}</td>
                      {#if event.orderFields}
                        {#each event.orderFields as field}
                          <td>{dec?.[field.id] ?? (decrypting ? "..." : "-")}</td>
                        {/each}
                      {/if}
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
    max-width: 900px;
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
    margin: 0 0 2rem;
  }

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
