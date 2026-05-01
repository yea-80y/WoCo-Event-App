<script lang="ts">
  import type { EventsGridSection as EventsGridSectionType, Site } from '@woco/shared';

  interface Props {
    section: EventsGridSectionType;
    site: Site;
    apiUrl: string;
  }

  let { section, site, apiUrl }: Props = $props();
  // Phase 3: fetch events from site.eventsIndexTopic feed and render cards
</script>

<div class="events-grid-wrap">
  <div class="inner">
    <div class="placeholder">
      <span class="icon">📅</span>
      <p>
        {section.mode === 'upcoming' ? 'Upcoming events' : section.mode === 'featured' ? 'Featured events' : 'All events'} will appear here once connected.
      </p>
      <p class="sub">Event grid connects to live data in Phase 3.</p>
    </div>
  </div>
</div>

<style>
  .events-grid-wrap {
    padding: 2.5rem 1.5rem;
  }

  .inner {
    max-width: 960px;
    margin: 0 auto;
  }

  .placeholder {
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    padding: 3rem 2rem;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
  }

  .icon { font-size: 2rem; }

  p {
    color: var(--muted);
    margin: 0;
    font-size: 0.9375rem;
  }

  .sub {
    font-size: 0.8rem;
    opacity: 0.6;
  }
</style>
