<script lang="ts">
  import type { GallerySection as GallerySectionType } from '@woco/shared';

  interface Props {
    section: GallerySectionType;
    gatewayUrl: string;
  }

  let { section, gatewayUrl }: Props = $props();
</script>

{#if section.images.length > 0}
  <div class="gallery-wrap">
    {#if section.title}
      <h2 class="gallery-heading">{section.title}</h2>
    {/if}
    <div class="grid">
      {#each section.images as img}
        <img
          src="{gatewayUrl}/bytes/{img.ref}"
          alt={img.alt}
          loading="lazy"
        />
      {/each}
    </div>
  </div>
{/if}

<style>
  .gallery-wrap {
    padding: var(--sec-pt, 2rem) 1.5rem var(--sec-pb, 1rem);
    max-width: 1100px;
    margin: 0 auto;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 0.625rem;
  }

  .gallery-heading {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--text);
    margin: 0 0 1.25rem;
  }

  img {
    width: 100%;
    aspect-ratio: 4 / 3;
    object-fit: cover;
    border-radius: var(--radius-sm);
    background: var(--card-bg);
  }
</style>
