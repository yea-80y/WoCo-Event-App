<script lang="ts">
  import type { EmbedSection as EmbedSectionType } from '@woco/shared';

  interface Props {
    section: EmbedSectionType;
  }

  let { section }: Props = $props();

  function sanitize(html: string): string {
    return html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  }
</script>

<div class="embed-wrap">
  <div class="inner">
    {@html sanitize(section.html)}
  </div>
</div>

<style>
  .embed-wrap {
    padding: 2.5rem 1.5rem;
    max-width: 760px;
    margin: 0 auto;
  }

  .inner :global(iframe) {
    width: 100%;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }
</style>
