<script lang="ts">
  import type { EmbedSection as EmbedSectionType } from '@woco/shared';
  // The organiser's pasted text is NEVER rendered. `resolveEmbed` extracts a
  // URL, checks it against an exact-host provider allowlist and rebuilds the
  // embed address itself — see embed-src.ts for the invariant.
  import { resolveEmbed } from './embed-src';

  interface Props {
    section: EmbedSectionType;
  }

  let { section }: Props = $props();

  const resolved = $derived(resolveEmbed(section.html));
</script>

<!-- Renders nothing when the paste does not resolve: a visitor should not be
     shown builder feedback. The organiser sees the reason in the site builder. -->
{#if resolved.ok}
  <div class="embed-wrap">
    <div class="inner">
      {#if section.title}
        <h2 class="embed-heading">{section.title}</h2>
      {/if}
      <!-- Height comes from the resolver: scaling players get an aspect box,
           fixed-height players (audio) get their pixel height. Without one of
           the two an iframe collapses to its 150px default. -->
      <div
        class="frame"
        style={resolved.height
          ? `height: ${resolved.height}px`
          : `aspect-ratio: ${resolved.aspect ?? '16 / 9'}`}
      >
        <iframe
          src={resolved.src}
          title={section.title ?? `${resolved.provider} embed`}
          loading="lazy"
          referrerpolicy="strict-origin-when-cross-origin"
          allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture"
          allowfullscreen
        ></iframe>
      </div>
    </div>
  </div>
{/if}

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

  .frame {
    width: 100%;
    overflow: hidden;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }

  .frame iframe {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
  }
</style>
