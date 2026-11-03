<script lang="ts">
  /**
   * The embed's seat map frame (/embed/seatmap/:eventId/:seriesId, our API origin):
   * the shared SeatPicker, fed from Swarm + the chain directly, talking to the ticket
   * widget that opened it through seatmap-bridge.ts. Holds and payment stay in the
   * widget; this frame says which seats.
   */
  import { onMount } from "svelte";
  import SeatPicker from "@woco/seatmap/svelte/SeatPicker.svelte";
  import { loadSeatMap } from "@woco/seatmap/load";
  import type { EventFeed, SeriesSummary } from "@woco/shared/event/types";
  import { WOCO_GATEWAY_URL } from "@woco/shared/swarm/feed-routes";
  import { KERNEL_CHAIN_ID } from "@woco/shared/kernel/chain";
  import { ticketLedger2Address } from "@woco/shared/ticket/ledger2";
  import { fromWidget, parseWidgetMessage, type FrameMessage } from "../seatmap-bridge.js";

  interface Props {
    eventId: string;
    seriesId: string;
    /** The widget's page origin (from the address): the only origin this frame talks to. */
    host: string | null;
  }
  let { eventId, seriesId, host }: Props = $props();

  // A public RPC for the chain the ledger is on. The frame's CSP allows exactly this origin.
  const RPC: Record<number, string> = { 42161: "https://arb1.arbitrum.io/rpc", 421614: "https://sepolia-rollup.arbitrum.io/rpc" };

  let event = $state.raw<EventFeed | null>(null);
  let series = $state.raw<SeriesSummary | null>(null);
  let failed = $state<string | null>(null);
  let canHold = $state(false);
  let pending: ((r: { ok: true; expiresAt: string } | { ok: false; message: string; conflicts?: number[] }) => void) | null = null;

  const framed = typeof window !== "undefined" && window.parent !== window;
  function post(m: FrameMessage): void {
    if (framed && host) window.parent.postMessage(m, host);
  }

  function onMessage(e: MessageEvent): void {
    if (!host || !fromWidget(e, window.parent, host)) return;
    const m = parseWidgetMessage(e.data);
    if (!m) return;
    if (m.type === "open") canHold = m.canHold;
    else if (m.type === "hold") { pending?.({ ok: true, expiresAt: m.expiresAt }); pending = null; }
    else if (m.type === "refused") { pending?.({ ok: false, message: m.message, conflicts: m.seats }); pending = null; }
  }

  async function hold(req: { seats: number[]; planDigest: string }) {
    pending?.({ ok: false, message: "Try again." });
    const answer = new Promise<{ ok: true; expiresAt: string } | { ok: false; message: string; conflicts?: number[] }>((resolve) => {
      pending = resolve;
      setTimeout(() => { if (pending === resolve) { pending = null; resolve({ ok: false, message: "That took too long. Try again." }); } }, 30_000);
    });
    post({ v: 1, type: "picked", seats: req.seats, planDigest: req.planDigest });
    return answer;
  }

  function close(): void {
    if (framed) post({ v: 1, type: "cancel" });
    else history.back();
  }

  onMount(() => {
    window.addEventListener("message", onMessage);
    (async () => {
      try {
        const resp = await fetch(`/api/events/${encodeURIComponent(eventId)}`);
        const body = (await resp.json()) as { ok?: boolean; data?: EventFeed };
        const ev = body.ok ? body.data ?? null : null;
        const s = ev?.series.find((x) => x.seriesId === seriesId) ?? null;
        if (!ev || !s || !s.seating) { failed = "These tickets don't have a seating plan."; return; }
        event = ev;
        series = s;
        post({ v: 1, type: "ready" });
      } catch {
        failed = "We couldn't load this event. Check your connection and try again.";
      }
    })();
    return () => window.removeEventListener("message", onMessage);
  });

  function load() {
    const s = series!;
    const ledger = ticketLedger2Address(KERNEL_CHAIN_ID);
    const rpcUrl = RPC[KERNEL_CHAIN_ID];
    if (!ledger || !rpcUrl || !s.seating || !s.onChainEventId || !s.swarmManifestRef) return Promise.resolve({ ok: false as const, problem: "not-seated" as const });
    return loadSeatMap(
      { eventId, seriesId, onChainEventId: s.onChainEventId, swarmManifestRef: s.swarmManifestRef, seating: s.seating },
      { fetch: (i, init) => fetch(i, init), gatewayUrl: WOCO_GATEWAY_URL, rpcUrl, apiUrl: location.origin, ledger },
    );
  }
</script>

{#if event && series}
  <SeatPicker {eventId} eventTitle={event.title} {series} {load} onclose={close} onhold={canHold ? hold : undefined} />
{:else if failed}
  <div class="sf-msg"><p>{failed}</p><button onclick={close}>Close</button></div>
{:else}
  <div class="sf-msg"><p>Loading the seating plan…</p></div>
{/if}

<style>
  .sf-msg { position: fixed; inset: 0; display: grid; place-content: center; justify-items: center; gap: 0.75rem; padding: 2rem; text-align: center; background: var(--bg); color: var(--text-secondary); font-family: var(--font-body); }
  .sf-msg button { padding: 0.5rem 1rem; border: 1px solid var(--border-hover); border-radius: var(--radius-md); background: var(--bg-elevated); color: var(--text); font: inherit; cursor: pointer; }
</style>
