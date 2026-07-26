<script lang="ts">
  import { renderLegalMarkdown } from "./markdown.js";

  interface Props {
    /** Slug from the route: privacy | terms | organiser-terms | dpa | cookies | index */
    doc: string;
  }

  let { doc }: Props = $props();

  // Raw markdown is the single source of truth — docs/legal/*.md are the
  // documents themselves, not a copy of them. Glob keeps them lazily chunked so
  // an attendee who never opens a policy never downloads one.
  const sources = import.meta.glob("../../../../../docs/legal/*.md", {
    query: "?raw",
    import: "default",
  }) as Record<string, () => Promise<string>>;

  const DOCS: Record<string, { title: string; file: string }> = {
    privacy: { title: "Privacy Policy", file: "PRIVACY_POLICY.md" },
    terms: { title: "Terms of Service", file: "TERMS_OF_SERVICE.md" },
    "organiser-terms": { title: "Organiser Terms", file: "ORGANISER_TERMS.md" },
    dpa: { title: "Data Processing Addendum", file: "DATA_PROCESSING_ADDENDUM.md" },
    cookies: { title: "Cookie Notice", file: "COOKIE_NOTICE.md" },
  };

  const entry = $derived(DOCS[doc]);

  const html = $derived.by(async () => {
    if (!entry) return null;
    const key = Object.keys(sources).find((k) => k.endsWith(`/${entry.file}`));
    if (!key) throw new Error(`Legal document not bundled: ${entry.file}`);
    return renderLegalMarkdown(await sources[key]());
  });
</script>

<svelte:head>
  <title>{entry ? `${entry.title} — WoCo` : "Legal — WoCo"}</title>
</svelte:head>

<div class="legal">
  <nav class="legal-nav" aria-label="Legal documents">
    <a href="#/" class="back">← WoCo</a>
    <div class="legal-links">
      {#each Object.entries(DOCS) as [slug, d]}
        <a href="#/legal/{slug}" class:active={slug === doc}>{d.title}</a>
      {/each}
    </div>
  </nav>

  {#if !entry}
    <div class="legal-body">
      <h1>Legal</h1>
      <p>Choose a document above.</p>
    </div>
  {:else}
    {#await html}
      <div class="legal-body"><p class="muted">Loading…</p></div>
    {:then rendered}
      <!-- Content is our own committed markdown, never user input. -->
      <article class="legal-body">{@html rendered}</article>
    {:catch}
      <div class="legal-body">
        <h1>{entry.title}</h1>
        <p class="muted">This document could not be loaded. Please try again, or contact support.</p>
      </div>
    {/await}
  {/if}
</div>

<style>
  .legal {
    max-width: 820px;
    margin: 0 auto;
    padding: 1.5rem 1.25rem 5rem;
  }

  .legal-nav {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding-bottom: 1rem;
    margin-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
  }

  .back {
    font-size: 0.8125rem;
    color: var(--text-muted);
    text-decoration: none;
  }
  .back:hover { color: var(--text); }

  .legal-links {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem 0.75rem;
  }

  .legal-links a {
    font-size: 0.75rem;
    color: var(--text-muted);
    text-decoration: none;
    padding: 0.25rem 0;
    border-bottom: 1px solid transparent;
  }
  .legal-links a:hover { color: var(--text); }
  .legal-links a.active {
    color: var(--accent-text);
    border-bottom-color: var(--accent);
  }

  .legal-body {
    color: var(--text-secondary);
    font-size: 0.875rem;
    line-height: 1.7;
  }

  .muted { color: var(--text-muted); }

  /* Rendered markdown — :global because {@html} output is not scoped. */
  .legal-body :global(h1) {
    font-size: 1.5rem;
    line-height: 1.25;
    color: var(--text);
    margin: 0 0 1rem;
  }
  .legal-body :global(h2) {
    font-size: 1.125rem;
    color: var(--text);
    margin: 2.25rem 0 0.75rem;
  }
  .legal-body :global(h3) {
    font-size: 0.9375rem;
    color: var(--text);
    margin: 1.75rem 0 0.5rem;
  }
  .legal-body :global(p) { margin: 0 0 0.875rem; }
  .legal-body :global(ul),
  .legal-body :global(ol) { margin: 0 0 0.875rem; padding-left: 1.25rem; }
  .legal-body :global(li) { margin-bottom: 0.375rem; }
  .legal-body :global(strong) { color: var(--text); font-weight: 600; }
  .legal-body :global(a) { color: var(--accent-text); text-decoration: underline; }
  .legal-body :global(code) {
    font-size: 0.8125em;
    padding: 0.1em 0.35em;
    border-radius: var(--radius-sm);
    background: var(--bg-input);
  }
  .legal-body :global(hr) {
    border: 0;
    border-top: 1px solid var(--border);
    margin: 2rem 0;
  }
  .legal-body :global(blockquote) {
    margin: 0 0 1rem;
    padding: 0.75rem 0.875rem;
    border-left: 3px solid var(--accent);
    background: var(--bg-input);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    font-size: 0.8125rem;
  }

  /* Wide tables scroll inside their own container — the page never does. */
  .legal-body :global(.table-wrap) {
    overflow-x: auto;
    margin: 0 0 1.25rem;
  }
  .legal-body :global(table) {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
  }
  .legal-body :global(th),
  .legal-body :global(td) {
    text-align: left;
    padding: 0.5rem 0.625rem;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  .legal-body :global(th) {
    color: var(--text);
    font-weight: 600;
    white-space: nowrap;
  }
</style>
