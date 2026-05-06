<script lang="ts">
  import type { ImageSection } from '@woco/shared';

  interface Props {
    section: ImageSection;
    gatewayUrl: string;
  }

  let { section, gatewayUrl }: Props = $props();

  const src = $derived(
    section.ref ? `${gatewayUrl}/bytes/${section.ref}` : ''
  );

  let loadFailed = $state(false);
</script>

{#if src && !loadFailed}
  <div class="image-section" class:contained={section.layout === 'contained'}>
    <figure class="figure">
      <img
        class="img"
        {src}
        alt={section.alt || ''}
        loading="lazy"
        onerror={() => { loadFailed = true; }}
      />
      {#if section.caption}
        <figcaption class="caption">{section.caption}</figcaption>
      {/if}
    </figure>
  </div>
{/if}

<style>
  .image-section {
    width: 100%;
    padding: 0;
  }

  .image-section.contained {
    padding: 0 1.5rem;
    max-width: 920px;
    margin: 0 auto;
    box-sizing: border-box;
  }

  .figure {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .img {
    width: 100%;
    height: auto;
    display: block;
    object-fit: cover;
  }

  .contained .img {
    border-radius: var(--radius-sm, 4px);
  }

  .caption {
    text-align: center;
    font-size: 0.8125rem;
    color: var(--muted, #a0a0a0);
    font-style: italic;
    line-height: 1.4;
    padding: 0 0.5rem;
  }
</style>
