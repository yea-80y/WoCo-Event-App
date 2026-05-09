<script lang="ts">
  import type { HeroSection as HeroSectionType } from '@woco/shared';

  interface Props {
    section: HeroSectionType;
    gatewayUrl: string;
  }

  let { section, gatewayUrl }: Props = $props();

  const bgStyle = $derived(
    section.bgImageRef
      ? `background-image: url(${gatewayUrl}/bytes/${section.bgImageRef})`
      : ''
  );
</script>

<section
  class="hero"
  style={bgStyle}
  class:has-bg={!!section.bgImageRef}
  class:heading-only={!section.subheading && !(section.ctaLabel && section.ctaHref)}
>
  <div class="inner">
    <h1>{section.heading}</h1>
    {#if section.subheading}
      <p class="sub">{section.subheading}</p>
    {/if}
    {#if section.ctaLabel && section.ctaHref}
      <a class="cta" href={section.ctaHref}>{section.ctaLabel}</a>
    {/if}
  </div>
</section>

<style>
  .hero {
    background: linear-gradient(160deg, var(--card-bg) 0%, var(--bg) 100%);
    min-height: 52vh;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 4rem 1.5rem 2.5rem;
    position: relative;
  }

  /* No bg image: let content height drive the section — no artificial min-height */
  .hero:not(.has-bg) {
    min-height: 0;
  }

  .hero.heading-only {
    padding: 3.5rem 1.5rem 2rem;
  }

  .hero.heading-only h1 {
    margin-bottom: 0;
  }

  .hero.has-bg {
    background-size: cover;
    background-position: center;
  }

  .hero.has-bg::before {
    content: '';
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
  }

  .inner {
    position: relative;
    z-index: 1;
    max-width: 720px;
  }

  h1 {
    font-size: clamp(2rem, 6vw, 3.75rem);
    font-weight: 700;
    margin: 0 0 1rem;
    color: var(--text);
    line-height: 1.1;
    letter-spacing: -0.02em;
  }

  .sub {
    font-size: 1.125rem;
    color: var(--muted);
    margin: 0 0 2rem;
    line-height: 1.65;
    max-width: 540px;
    margin-left: auto;
    margin-right: auto;
  }

  .cta {
    display: inline-block;
    padding: 0.75rem 2rem;
    background: var(--accent);
    color: #fff;
    font-weight: 600;
    font-size: 0.9375rem;
    border-radius: var(--radius-sm);
    text-decoration: none;
    transition: background var(--transition);
  }

  .cta:hover {
    background: var(--accent-hover);
    text-decoration: none;
  }
</style>
