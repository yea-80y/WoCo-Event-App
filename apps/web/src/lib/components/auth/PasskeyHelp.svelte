<script lang="ts">
  /**
   * "Can't find your passkey on this device?" (#746): a passkey lives in the password
   * manager that made it. Sync managers reach this device once signed in; the ones
   * that stay put need this device added from a phone instead. Loaded when opened.
   */
  let { busy, onretry, onlink }: { busy: boolean; onretry: () => void; onlink?: () => void } = $props();
</script>

<div class="help" role="region" aria-label="Can't find your passkey on this device?">
  <p class="help-title">It lives in the password manager you made it with.</p>
  <div class="help-option">
    <p><strong>Google Password Manager, 1Password or Bitwarden</strong></p>
    <p>Sign in to it on this device - in Chrome for Google - then try again.</p>
    <button class="option-btn" onclick={onretry} disabled={busy}>Try again</button>
  </div>
  <div class="help-option">
    <p><strong>Samsung Pass, Apple Passwords or Windows Hello</strong></p>
    <p>These stay on their own devices. Add this device from your phone instead.</p>
    {#if onlink}
      <button class="option-btn" onclick={onlink} disabled={busy}>Add this device</button>
    {/if}
  </div>
</div>

<style>
  .help,
  .help-option {
    display: grid;
    gap: 0.4rem;
  }
  .help {
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .help p {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }
  .help .help-title,
  .help strong {
    color: var(--text);
    font-weight: 600;
  }
  .help-option + .help-option {
    padding-top: 0.5rem;
    border-top: 1px solid var(--border);
  }
  .option-btn {
    padding: 0.5rem;
    font-size: 0.8125rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
  }
  .option-btn:disabled {
    opacity: 0.5;
  }
</style>
