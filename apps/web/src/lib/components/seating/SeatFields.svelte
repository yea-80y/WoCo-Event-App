<!--
  A ticket's seat as labelled fields - Section / Row / Seat, or Table / Seat - the way
  wallet passes print it, never as a sentence: the steward's headline on the door
  scanner. Colour comes from the parent (`currentColor`). Screen readers get the one
  sentence ("Stalls, Row D, seat 7").
-->
<script lang="ts">
  import { ticketSeatFields, ticketSeatNote, ticketSeatText, type TicketSeat } from "@woco/shared/seating/ticket-seat";

  let { seat }: { seat: TicketSeat } = $props();

  const fields = $derived(ticketSeatFields(seat));
  const note = $derived(ticketSeatNote(seat));
  const spoken = $derived(`${ticketSeatText(seat)}${note ? `, ${note.toLowerCase()}` : ""}`);
</script>

<div class="seat-fields" role="group" aria-label={spoken}>
  <dl aria-hidden="true">
    {#each fields as f, i (f.label)}
      <div class="field" class:grow={i === 0}>
        <dt>{f.label}</dt>
        <dd>{f.value}</dd>
      </div>
    {/each}
  </dl>
  {#if note}<p class="note" aria-hidden="true">{note}</p>{/if}
</div>

<style>
  .seat-fields {
    width: min(100%, 26rem);
    padding: 0.85rem 1.1rem 0.95rem;
    border-radius: var(--radius-md);
    background: rgba(0, 0, 0, 0.12);
    color: inherit;
    text-align: left;
  }
  /* A section name too long for one line takes its own, Row and Seat below it:
     the steward reads every part whole, never cut short. */
  dl {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1.25rem;
    margin: 0;
    min-width: 0;
  }
  .field {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .field.grow {
    flex: 1 1 auto;
  }
  dt {
    font-size: 0.875rem;
    font-weight: 600;
    opacity: 0.72;
  }
  dd {
    margin: 0;
    font-size: clamp(2rem, 10vw, 3.25rem);
    font-weight: 800;
    line-height: 1.05;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .grow dd {
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .note {
    margin: 0.35rem 0 0;
    font-size: 1rem;
    font-weight: 700;
  }
</style>
