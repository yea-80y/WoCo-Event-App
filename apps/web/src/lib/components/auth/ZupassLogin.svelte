<script lang="ts">
  // Zupass login — stubbed for v1, architecture ready for integration
</script>

<div class="zupass-login">
  <button class="zupass-btn" disabled>
    Sign in with Zupass
  </button>
  <p class="hint">Coming soon</p>
</div>

<style>
  .zupass-login {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.5rem;
  }

  .zupass-btn {
    padding: 0.75rem;
    font-size: 0.9375rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    color: var(--text-muted);
    border: 1px solid var(--border);
    opacity: 0.5;
    cursor: not-allowed;
  }

  .hint {
    color: var(--text-muted);
    font-size: 0.75rem;
    text-align: center;
    margin: 0;
  }
</style>
