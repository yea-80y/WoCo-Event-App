<script lang="ts">
  import type { Section, Site } from '@woco/shared';
  import HeroSection from './HeroSection.svelte';
  import RichTextSection from './RichTextSection.svelte';
  import GallerySection from './GallerySection.svelte';
  import EventsGridSection from './EventsGridSection.svelte';
  import FeaturedEventSection from './FeaturedEventSection.svelte';
  import OpeningHoursSection from './OpeningHoursSection.svelte';
  import MapSection from './MapSection.svelte';
  import ContactFormSection from './ContactFormSection.svelte';
  import EmbedSection from './EmbedSection.svelte';
  import ImageSection from './ImageSection.svelte';

  interface Props {
    section: Section;
    site: Site;
    gatewayUrl: string;
    apiUrl: string;
  }

  let { section, site, gatewayUrl, apiUrl }: Props = $props();

  // CSS variables injected on the wrapper control vertical padding inside each
  // section component via var(--sec-pt) / var(--sec-pb). Hero manages its own
  // spacing (bg image, min-height) so is excluded.
  const spacingStyle = $derived.by(() => {
    if (section.type === 'hero') return '';
    switch (section.spacing) {
      case 'compact':  return '--sec-pt:1rem;--sec-pb:0.5rem';
      case 'spacious': return '--sec-pt:4rem;--sec-pb:2.5rem';
      default:         return '';
    }
  });

  const CARD_SECTIONS = new Set(['richText', 'openingHours', 'contactForm', 'embed']);
</script>

{#if section.type === 'hero'}
  <HeroSection {section} {gatewayUrl} />
{:else}
  <div
    class="section-wrap"
    class:section-card={CARD_SECTIONS.has(section.type)}
    style={spacingStyle}
  >
    {#if section.type === 'richText'}
      <RichTextSection {section} />
    {:else if section.type === 'gallery'}
      <GallerySection {section} {gatewayUrl} />
    {:else if section.type === 'image'}
      <ImageSection {section} {gatewayUrl} />
    {:else if section.type === 'eventsGrid'}
      <EventsGridSection {section} {site} {apiUrl} />
    {:else if section.type === 'featuredEvent'}
      <FeaturedEventSection {section} {apiUrl} {gatewayUrl} />
    {:else if section.type === 'openingHours'}
      <OpeningHoursSection {section} />
    {:else if section.type === 'map'}
      <MapSection {section} />
    {:else if section.type === 'contactForm'}
      <ContactFormSection {section} {site} {apiUrl} />
    {:else if section.type === 'embed'}
      <EmbedSection {section} />
    {/if}
  </div>
{/if}

<style>
  .section-wrap {
    border-top: 1px solid var(--border);
  }

  .section-card {
    background: var(--card-bg);
  }
</style>
