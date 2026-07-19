<script lang="ts">
  import type { Component } from "svelte";

  let {
    loader,
    props = {},
  }: {
    loader: () => Promise<{ default: unknown }>;
    props?: Record<string, unknown>;
  } = $props();

  const component = $derived(
    loader().then((m) => m.default as Component<Record<string, unknown>>)
  );
</script>

{#await component}
  <div class="route-loading">Loading…</div>
{:then Comp}
  <Comp {...props} />
{:catch}
  <div class="route-loading route-error">
    Failed to load this page. Please refresh.
  </div>
{/await}

<style>
  .route-loading {
    max-width: 840px;
    margin: 0 auto;
    padding: 4rem 1.25rem;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.875rem;
    /* Hold back the text briefly so warm-cache loads never flash it. */
    animation: route-loading-in 0.2s ease 0.15s both;
  }
  .route-error {
    color: var(--text);
    animation: none;
  }
  @keyframes route-loading-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
</style>
