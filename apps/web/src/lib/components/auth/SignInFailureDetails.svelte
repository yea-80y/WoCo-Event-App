<script lang="ts">
  // A failed sign-in, the same everywhere it is shown (signin-failure-notice.ts):
  // the line, the copyable code, and Web3Auth's own reason - redacted on this
  // device - only when the person taps for it. Render it inside a {#key} on the
  // failure, so a new attempt starts with the details hidden again.
  import type { SignInFailureView } from "../../auth/signin-failure-notice.js";

  interface Props {
    failure: SignInFailureView;
  }

  let { failure }: Props = $props();

  let showDetail = $state(false);
</script>

<p class="error">{failure.message}</p>
{#if failure.code}
  <p class="error-code">Code: <code>{failure.code}</code></p>
  {#if failure.detail && !showDetail}
    <button type="button" class="detail-btn" onclick={() => (showDetail = true)}>Show details</button>
  {:else if failure.detail}
    <p class="error-code">Details: <code>{failure.detail}</code></p>
    <p class="detail-note">Links, email addresses and long codes are hidden; a name or user id may not be. Check it before you share it.</p>
  {/if}
{/if}

<style>
  .error {
    color: var(--error);
    font-size: 0.875rem;
    margin: 0;
    text-align: center;
  }

  .error-code {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-muted);
    text-align: center;
    overflow-wrap: anywhere;
  }

  .error-code code {
    user-select: all;
    -webkit-user-select: all;
  }

  .detail-btn {
    align-self: center;
    padding: 0.25rem 0.5rem;
    border: 0;
    background: none;
    color: var(--accent-text);
    font: inherit;
    font-size: 0.75rem;
    cursor: pointer;
  }

  .detail-note {
    margin: 0;
    font-size: 0.6875rem;
    color: var(--text-muted);
    text-align: center;
  }
</style>
