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
    {#if section.title}
      <h2 class="embed-heading">{section.title}</h2>
    {/if}
    {@html sanitize(section.html)}
  </div>
</div>

<style>
  .embed-wrap {
    padding: var(--sec-pt, 2rem) 1.5rem var(--sec-pb, 1rem);
  }

  .inner {
    max-width: 760px;
    margin: 0 auto;
  }

  .embed-heading {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--text);
    margin: 0 0 1.25rem;
  }

  .inner :global(iframe) {
    width: 100%;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }
</style>
