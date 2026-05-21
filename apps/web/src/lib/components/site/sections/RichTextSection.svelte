<script lang="ts">
  import type { RichTextSection as RichTextSectionType } from '@woco/shared';

  interface Props {
    section: RichTextSectionType;
  }

  let { section }: Props = $props();

  function renderMarkdown(md: string): string {
    return md
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .split(/\n\n+/)
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => (p.startsWith('<h') ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`))
      .join('\n');
  }
</script>

<div class="richtext">
  <div class="inner">
    {@html renderMarkdown(section.markdown)}
  </div>
</div>

<style>
  .richtext {
    padding: var(--sec-pt, 2.5rem) 1.5rem var(--sec-pb, 1.5rem);
  }

  .inner {
    max-width: 760px;
    margin: 0 auto;
  }

  .inner :global(h1),
  .inner :global(h2),
  .inner :global(h3) {
    color: var(--text);
    margin: 0 0 1rem;
    line-height: 1.25;
  }

  .inner :global(h1) { font-size: 2rem; }
  .inner :global(h2) { font-size: 1.625rem; }
  .inner :global(h3) { font-size: 1.25rem; }

  .inner :global(p) {
    color: var(--muted);
    margin: 0 0 1rem;
    line-height: 1.75;
    font-size: 1rem;
    overflow-wrap: break-word;
    word-break: break-word;
  }

  .inner :global(strong) { color: var(--text); font-weight: 600; }
  .inner :global(em) { font-style: italic; }
</style>
