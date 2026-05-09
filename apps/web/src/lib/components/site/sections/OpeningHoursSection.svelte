<script lang="ts">
  import type { OpeningHoursSection as OpeningHoursSectionType } from '@woco/shared';

  interface Props {
    section: OpeningHoursSectionType;
  }

  let { section }: Props = $props();
</script>

<div class="hours-wrap">
  <div class="inner">
    <h2>{section.title || 'Opening Hours'}</h2>
    <table>
      <tbody>
        {#each section.rows as row}
          <tr>
            <td class="day">{row.day}</td>
            <td class="time">{row.hours}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>

<style>
  .hours-wrap {
    padding: var(--sec-pt, 2.5rem) 1.5rem var(--sec-pb, 1.5rem);
  }

  .inner {
    max-width: 500px;
    margin: 0 auto;
  }

  h2 {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--text);
    margin: 0 0 1.5rem;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  tr {
    border-bottom: 1px solid var(--border);
  }

  tr:last-child {
    border-bottom: none;
  }

  td {
    padding: 0.875rem 0;
    font-size: 0.9375rem;
  }

  .day {
    color: var(--muted);
    width: 48%;
  }

  .time {
    color: var(--text);
    font-weight: 500;
  }
</style>
