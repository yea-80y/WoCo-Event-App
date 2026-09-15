<!--
  PassportTicket — one linked ticket drawn as a stub: the date on the left, the
  event in the middle, the ticket number past a perforation cut into the card.
  A ticket whose event is known opens the event; one whose details have not
  arrived says so and opens nothing.
-->
<script lang="ts">
  import { openEvent } from "../events/open-event.js";
  import { daysUntil, whenLabel, type PassportTicket as Ticket } from "./passport.js";

  let {
    ticket,
    now,
    size = "row",
    pending = false,
  }: {
    ticket: Ticket;
    now: number;
    size?: "row" | "large";
    /** Event details are still being fetched. */
    pending?: boolean;
  } = $props();

  const event = $derived(ticket.event);
  const start = $derived.by(() => {
    const date = event ? new Date(event.startDate) : null;
    return date && !isNaN(date.getTime()) ? date : null;
  });
  const when = $derived(event ? whenLabel(daysUntil(event.startDate, now)) : null);

  function open() {
    if (!event) return;
    openEvent({ eventId: ticket.eventId, apiUrl: event.apiUrl, creatorFeedSigner: event.creatorFeedSigner });
  }
</script>

{#snippet face()}
  <span class="date" aria-hidden="true">
    {#if start}
      <span class="month">{start.toLocaleDateString(undefined, { month: "short" })}</span>
      <span class="day">{start.getDate()}</span>
    {:else}
      <span class="day day--blank">··</span>
    {/if}
  </span>
  <span class="main">
    <span class="title">{event?.title ?? `Ticket #${ticket.edition}`}</span>
    <span class="meta">
      {#if start}
        <span class="sr-only">{start.toLocaleDateString(undefined, { day: "numeric", month: "long" })},</span>
        {start.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}{#if event?.location}<span aria-hidden="true"> · </span>{event.location}{/if}
      {:else if event}
        {event.location}
      {:else}
        {pending ? "Loading event details" : "Event details couldn't load right now"}
      {/if}
    </span>
    {#if when}<span class="when">{when}</span>{/if}
  </span>
  <span class="edition"><span class="sr-only">Ticket </span>#{ticket.edition}</span>
{/snippet}

{#if event}
  <button type="button" class="stub stub--{size}" onclick={open}>{@render face()}</button>
{:else}
  <div class="stub stub--{size}">{@render face()}</div>
{/if}

<style>
  .stub {
    --perf: 3.5rem;
    --notch: 0.4375rem;
    --cut-top: radial-gradient(circle at calc(100% - var(--perf)) 0, transparent var(--notch), black calc(var(--notch) + 0.5px));
    --cut-bottom: radial-gradient(circle at calc(100% - var(--perf)) 100%, transparent var(--notch), black calc(var(--notch) + 0.5px));
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) var(--perf);
    width: 100%;
    padding: 0;
    text-align: left;
    font: inherit;
    color: var(--text);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    /* Two semicircle cuts where the perforation meets each edge. */
    -webkit-mask: var(--cut-top) top / 100% 51% no-repeat, var(--cut-bottom) bottom / 100% 51% no-repeat;
    mask: var(--cut-top) top / 100% 51% no-repeat, var(--cut-bottom) bottom / 100% 51% no-repeat;
  }
  button.stub {
    cursor: pointer;
    transition: border-color var(--transition), background var(--transition);
  }
  button.stub:hover { border-color: var(--text-dim); }
  button.stub:active { background: var(--bg-elevated); }
  /* The mask clips anything outside the card, an outline included. */
  button.stub:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent); }

  .date {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-width: 3.25rem;
    padding: 0.625rem 0.5rem;
    border-right: 1px solid var(--border);
  }
  .month {
    font-family: var(--font-mono);
    font-size: 0.625rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .day {
    font-family: var(--font-display);
    font-size: 1.375rem;
    font-weight: 700;
    line-height: 1.05;
    letter-spacing: -0.03em;
    font-variant-numeric: tabular-nums;
  }
  .day--blank { color: var(--text-dim); }

  .main {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
    padding: 0.625rem 0.875rem;
  }
  .title,
  .meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title { font-size: 0.9375rem; font-weight: 600; letter-spacing: -0.01em; }
  .meta { font-size: 0.8125rem; color: var(--text-muted); }
  .when { margin-top: 0.125rem; font-size: 0.75rem; font-weight: 600; color: var(--accent); }

  .edition {
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--text-muted);
    border-left: 1px dashed var(--text-dim);
  }

  .stub--large .date { min-width: 4rem; padding: 0.875rem 0.625rem; }
  .stub--large .day { font-size: 1.875rem; }
  .stub--large .main { gap: 0.25rem; padding: 0.875rem 1rem; }
  .stub--large .title {
    font-size: 1.1875rem;
    line-height: 1.2;
    white-space: normal;
    overflow-wrap: anywhere;
  }
</style>
