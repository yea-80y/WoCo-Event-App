<script lang="ts">
  /**
   * The scanner could not start - its storage on this phone would not open.
   * A retry, and nothing else: no reset is offered here, because the storage
   * that would not open may hold check-ins that have not reached WoCo yet.
   */
  let { onRetry }: { onRetry: () => void } = $props();
</script>

<div class="boot-failed" role="alert">
  <h1>The scanner couldn't start</h1>
  <p>It couldn't open its storage on this phone. Nothing stored on it has been deleted.</p>
  <button type="button" onclick={onRetry}>Try again</button>
</div>

<style>
  .boot-failed {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: 1.5rem;
    text-align: center;
  }
  h1 {
    margin: 0;
    font-size: 1.125rem;
    color: var(--text);
  }
  p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.9375rem;
    line-height: 1.45;
  }
  button {
    background: var(--accent);
    color: var(--accent-ink);
    border: none;
    border-radius: var(--radius-md);
    font-weight: 700;
    padding: 0.7rem 1.2rem;
  }
</style>
