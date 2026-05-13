<script lang="ts">
  interface Props {
    email: string | null;
    qty: number;
    ondismiss: () => void;
  }
  let { email, qty, ondismiss }: Props = $props();
</script>

<div
  class="ses-overlay"
  role="dialog"
  aria-modal="true"
  aria-labelledby="ses-title"
  onclick={(e) => { if ((e.target as HTMLElement).classList.contains("ses-overlay")) ondismiss(); }}
  onkeydown={(e) => { if (e.key === "Escape") ondismiss(); }}
>
  <div class="ses-modal" role="document">
    <button class="ses-close" onclick={ondismiss} aria-label="Close">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/>
      </svg>
    </button>

    <div class="ses-check" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </div>

    <h2 id="ses-title" class="ses-title">Payment confirmed</h2>
    <p class="ses-lede">
      {qty > 1 ? `Your ${qty} tickets are` : "Your ticket is"} on the way to your inbox.
    </p>

    <div class="ses-email-card">
      <span class="ses-email-label">Sent to</span>
      {#if email}
        <span class="ses-email-addr">{email}</span>
      {:else}
        <span class="ses-email-addr ses-email-addr--unknown">your email</span>
      {/if}
    </div>

    <ul class="ses-steps">
      <li><span class="ses-step-bullet"></span>Check your inbox in the next few minutes.</li>
      <li><span class="ses-step-bullet"></span>If you don't see it, check your spam folder.</li>
      <li><span class="ses-step-bullet"></span>Show the QR code in the email at the door.</li>
    </ul>

    <button class="ses-done" onclick={ondismiss}>Done</button>

    <p class="ses-foot">
      A receipt has been sent by Stripe. Need help? Contact the organiser.
    </p>
  </div>
</div>

<style>
  .ses-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    background: rgba(8, 8, 14, 0.78);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: max(1.5rem, env(safe-area-inset-top)) 1rem max(1.5rem, env(safe-area-inset-bottom));
    animation: ses-fade 200ms ease;
    overflow-y: auto;
  }
  @keyframes ses-fade {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  .ses-modal {
    position: relative;
    width: 100%;
    max-width: 420px;
    margin: auto;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 14px);
    padding: 2rem 1.5rem 1.5rem;
    text-align: center;
    box-shadow: 0 24px 48px -16px rgba(0, 0, 0, 0.55);
    animation: ses-rise 320ms cubic-bezier(0.2, 0.9, 0.3, 1);
  }
  @keyframes ses-rise {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .ses-close {
    position: absolute;
    top: 0.625rem;
    right: 0.625rem;
    width: 1.75rem;
    height: 1.75rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .ses-close:hover { background: var(--bg-surface-hover); color: var(--text); }

  .ses-check {
    width: 2.5rem;
    height: 2.5rem;
    margin: 0 auto 1rem;
    border-radius: 50%;
    background: color-mix(in srgb, var(--success) 16%, transparent);
    color: var(--success);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: ses-check-pop 360ms cubic-bezier(0.2, 0.9, 0.3, 1) 80ms backwards;
  }
  @keyframes ses-check-pop {
    from { opacity: 0; transform: scale(0.8); }
    to   { opacity: 1; transform: scale(1); }
  }

  .ses-title {
    font-size: 1.375rem;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.015em;
    margin: 0 0 0.375rem;
  }
  .ses-lede {
    font-size: 0.9375rem;
    color: var(--text-secondary);
    line-height: 1.5;
    margin: 0 0 1.25rem;
  }

  .ses-email-card {
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 0.75rem 1rem;
    margin: 0 0 1.25rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
  }
  .ses-email-label {
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .ses-email-addr {
    font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
    font-size: 0.9375rem;
    font-weight: 500;
    color: var(--text);
    word-break: break-all;
    line-height: 1.3;
  }
  .ses-email-addr--unknown { font-style: italic; color: var(--text-muted); font-weight: 400; }

  .ses-steps {
    list-style: none;
    margin: 0 0 1.5rem;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    text-align: left;
  }
  .ses-steps li {
    display: flex;
    align-items: baseline;
    gap: 0.625rem;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    line-height: 1.5;
  }
  .ses-step-bullet {
    flex-shrink: 0;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--text-muted);
    transform: translateY(-3px);
  }

  .ses-done {
    width: 100%;
    padding: 0.75rem 1rem;
    background: var(--accent);
    color: #fff;
    font-weight: 600;
    font-size: 0.9375rem;
    border: none;
    border-radius: var(--radius-md);
    transition: background 0.15s;
    cursor: pointer;
  }
  .ses-done:hover { background: var(--accent-hover); }

  .ses-foot {
    margin: 1rem 0 0;
    font-size: 0.6875rem;
    color: var(--text-muted);
    line-height: 1.5;
  }

  @media (max-width: 480px) {
    .ses-modal { padding: 1.75rem 1.125rem 1.125rem; }
    .ses-title { font-size: 1.25rem; }
  }
</style>
