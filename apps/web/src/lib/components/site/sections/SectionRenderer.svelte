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
</script>

{#if section.type === 'hero'}
  <HeroSection {section} {gatewayUrl} />
{:else if section.type === 'richText'}
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
