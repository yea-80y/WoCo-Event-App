<!--
  WocoWordmark — type-based brand mark in computer-terminal style.

  WOCO is set in JetBrains Mono 700 (the coding font used elsewhere in
  the app), evoking a CLI / terminal aesthetic that matches the
  "World Computer" framing. The "// WORLD COMPUTER" tagline sits
  directly beneath the wordmark — proper logo + descriptor lockup —
  picking up the editorial slash-comment motif used on the page hero.

  Props:
    height       cap-height of the WOCO wordmark in CSS pixels
    variant      "default" (bone + accent) | "solid" (full accent) | "ink" (all bone)
    showTagline  show "// WORLD COMPUTER" beneath the wordmark (default true)
    onclick      optional click handler — wraps in a button
-->
<script lang="ts">
  interface Props {
    height?: number;
    variant?: "default" | "solid" | "ink";
    showTagline?: boolean;
    onclick?: () => void;
    title?: string;
  }
  let {
    height = 24,
    variant = "default",
    showTagline = true,
    onclick,
    title = "WoCo — World Computer",
  }: Props = $props();

  const wordColor = $derived(variant === "solid" ? "var(--accent)" : "var(--text)");
  const tagColor = $derived(
    variant === "solid" ? "var(--accent-ink)" :
    variant === "ink"   ? "var(--text-secondary)" :
    "var(--accent)"
  );
</script>

{#if onclick}
  <button class="mark mark-btn" {onclick} aria-label={title} style:--mark-h="{height}px">
    {@render mark()}
  </button>
{:else}
  <span class="mark" aria-label={title} role="img" style:--mark-h="{height}px">
    {@render mark()}
  </span>
{/if}

{#snippet mark()}
  <span class="word" style:color={wordColor}>WOCO</span>
  {#if showTagline}
    <span class="tag" style:color={tagColor}>// WORLD COMPUTER</span>
  {/if}
{/snippet}

<style>
  .mark {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    line-height: 1;
    font-family: var(--font-mono);
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .mark-btn {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: inherit;
    transition: transform var(--transition-fast);
  }
  .mark-btn:hover { transform: translateX(1px); }
  .mark-btn:active { transform: translateX(0); }

  .word {
    font-size: var(--mark-h);
    line-height: 0.9;
  }
  .tag {
    /* Tagline ≈ 36% of wordmark height — sits as a true descriptor underline */
    font-size: calc(var(--mark-h) * 0.36);
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    white-space: nowrap;
    margin-top: calc(var(--mark-h) * 0.18);
    /* Align tagline left-edge with wordmark left-edge — no indent */
  }
</style>
