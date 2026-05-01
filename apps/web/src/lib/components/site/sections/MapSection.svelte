<script lang="ts">
  import type { MapSection as MapSectionType } from '@woco/shared';

  interface Props {
    section: MapSectionType;
  }

  let { section }: Props = $props();

  const d = 0.008;
  const zoom = $derived(section.zoom ?? 15);
  const bbox = $derived(`${section.lng - d},${section.lat - d},${section.lng + d},${section.lat + d}`);
  const embedUrl = $derived(`https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${section.lat},${section.lng}`);
  const externalUrl = $derived(`https://www.openstreetmap.org/?mlat=${section.lat}&mlon=${section.lng}#map=${zoom}/${section.lat}/${section.lng}`);
</script>

<div class="map-wrap">
  <div class="inner">
    {#if section.label}
      <p class="label">{section.label}</p>
    {/if}
    <div class="frame">
      <iframe
        src={embedUrl}
        title={section.label ?? 'Map'}
        loading="lazy"
        allowfullscreen
      ></iframe>
    </div>
    <a class="ext" href={externalUrl} target="_blank" rel="noopener noreferrer">
      View on OpenStreetMap ↗
    </a>
  </div>
</div>

<style>
  .map-wrap {
    padding: 3rem 1.5rem;
  }

  .inner {
    max-width: 840px;
    margin: 0 auto;
  }

  .label {
    font-size: 1rem;
    font-weight: 600;
    color: var(--text);
    margin: 0 0 0.875rem;
  }

  .frame {
    border-radius: var(--radius-md);
    overflow: hidden;
    border: 1px solid var(--border);
  }

  iframe {
    display: block;
    width: 100%;
    height: 400px;
    border: 0;
  }

  .ext {
    display: inline-block;
    margin-top: 0.625rem;
    font-size: 0.8125rem;
    color: var(--muted);
    text-decoration: none;
  }

  .ext:hover { color: var(--accent); }
</style>
