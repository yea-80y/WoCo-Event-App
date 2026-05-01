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
    padding: 2.5rem 1.5rem;
    max-width: 1100px;
    margin: 0 auto;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 0.625rem;
  }

  img {
    width: 100%;
    aspect-ratio: 4 / 3;
    object-fit: cover;
    border-radius: var(--radius-sm);
    background: var(--card-bg);
  }
</style>
