<script lang="ts">
  /**
   * Renders an organiser privacy notice document. Text only: every string is
   * Svelte-escaped, and a link renders only when its href passes
   * `isSafeNoticeHref` (mailto: with a valid address, or https) - anything else
   * renders as plain text, so a future edit to the generator cannot become script
   * on an organiser's domain.
   *
   * `editor` mode highlights the gaps the organiser still has to fill; `public`
   * mode shows the docs-backed fallback, or that the organiser has not added it.
   * Public mode renders nothing for an unconfirmed document: WoCo's pre-filled
   * draft is never shown to attendees as the organiser's notice.
   */
  import { isSafeNoticeHref, NOTICE_NOT_ADDED, type NoticeInline, type OrganiserNoticeDoc } from "@woco/shared";

  interface Props {
    doc: OrganiserNoticeDoc;
    mode?: "public" | "editor";
  }
  let { doc, mode = "public" }: Props = $props();
</script>

{#snippet inline(content: NoticeInline[])}
  {#each content as part}
    {#if typeof part === "string"}{part}{:else if isSafeNoticeHref(part.href)}<a
        href={part.href}
        target={part.href.startsWith("mailto:") ? undefined : "_blank"}
        rel="noopener noreferrer">{part.text}</a
      >{:else}{part.text}{/if}
  {/each}
{/snippet}

{#if mode === "editor" || doc.confirmed}
<article class="notice">
  <h1 class="notice-title">{doc.title}</h1>
  {#each doc.sections as section (section.id)}
    <section class="notice-section">
      {#if section.heading}<h2>{section.heading}</h2>{/if}
      {#each section.blocks as block}
        {#if block.kind === "p"}
          <p>{@render inline(block.content)}</p>
        {:else if block.kind === "list"}
          <ul>
            {#each block.items as item}<li>{@render inline(item)}</li>{/each}
          </ul>
        {:else if mode === "editor"}
          <p class="todo"><span class="todo-tag">To complete</span> {block.prompt}</p>
          {#if block.fallback}<p class="todo-fallback">Until you do, attendees see: {@render inline(block.fallback)}</p>{/if}
        {:else if block.fallback}
          <p>{@render inline(block.fallback)}</p>
        {:else}
          <p class="not-added">{block.lead ?? ""}{NOTICE_NOT_ADDED}</p>
        {/if}
      {/each}
    </section>
  {/each}
  <footer class="notice-footer">
    {#each doc.footer as line}<p>{line}</p>{/each}
  </footer>
</article>
{/if}

<style>
  .notice {
    color: var(--text-primary, var(--text));
    font-size: 0.9375rem;
    line-height: 1.6;
    max-width: 720px;
  }
  .notice-title {
    font-size: 1.5rem;
    margin: 0 0 1rem;
  }
  .notice-section h2 {
    font-size: 1.0625rem;
    margin: 1.5rem 0 0.5rem;
  }
  .notice p,
  .notice ul {
    margin: 0 0 0.625rem;
  }
  .notice ul {
    padding-left: 1.25rem;
  }
  .notice li {
    margin-bottom: 0.375rem;
  }
  .notice a {
    color: var(--accent);
    text-decoration: underline;
    word-break: break-word;
  }
  .not-added {
    color: var(--text-muted, var(--muted));
    font-style: italic;
  }
  .todo {
    border-left: 3px solid var(--accent);
    padding: 0.375rem 0.625rem;
    background: var(--bg-elevated, var(--card-bg));
    border-radius: var(--radius-sm, 4px);
  }
  .todo-tag {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--accent);
  }
  .todo-fallback {
    color: var(--text-muted, var(--muted));
    font-size: 0.875rem;
  }
  .notice-footer {
    margin-top: 1.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
    color: var(--text-muted, var(--muted));
    font-size: 0.8125rem;
  }
</style>
