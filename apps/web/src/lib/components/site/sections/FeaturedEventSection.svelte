<script lang="ts">
  import type { FeaturedEventSection as FeaturedEventSectionType } from '@woco/shared';

  interface Props {
    section: FeaturedEventSectionType;
    apiUrl: string;
    gatewayUrl: string;
  }

  let { section, apiUrl, gatewayUrl }: Props = $props();
  // Phase 3: load event detail and render inline
</script>

<div class="featured-wrap">
  <div class="placeholder">
    <p>Featured event — connects to live data in Phase 3.</p>
    <code>{section.eventId}</code>
  </div>
</div>

<style>
  .featured-wrap {
    padding: 2.5rem 1.5rem;
    max-width: 720px;
    margin: 0 auto;
  }

  .placeholder {
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    padding: 2.5rem;
    text-align: center;
  }

  p {
    color: var(--muted);
    margin: 0 0 0.5rem;
    font-style: italic;
  }

  code {
    font-size: 0.8rem;
    color: var(--muted);
    opacity: 0.7;
  }
</style>
