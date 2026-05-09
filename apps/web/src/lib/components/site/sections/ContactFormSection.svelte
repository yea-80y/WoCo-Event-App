<script lang="ts">
  import type { ContactFormSection as ContactFormSectionType, Site } from '@woco/shared';

  interface Props {
    section: ContactFormSectionType;
    site: Site;
    apiUrl: string;
  }

  let { section, site, apiUrl }: Props = $props();

  let name = $state('');
  let email = $state('');
  let message = $state('');
  let status = $state<'idle' | 'sending' | 'sent' | 'error'>('idle');
  let errorMsg = $state('');

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    status = 'sending';
    try {
      const resp = await fetch(`${apiUrl}/api/sites/${site.siteId}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, message }),
      });
      const json = await resp.json() as { ok: boolean; error?: string };
      if (!resp.ok || !json.ok) throw new Error(json.error ?? 'Failed to send');
      status = 'sent';
    } catch (err) {
      status = 'error';
      errorMsg = err instanceof Error ? err.message : 'Something went wrong. Please try again.';
    }
  }
</script>

<div class="contact-wrap">
  <div class="inner">
    <h2>{section.title || 'Send us a message'}</h2>
    {#if status === 'sent'}
      <p class="success">Thanks! We'll be in touch soon.</p>
    {:else}
      <form onsubmit={handleSubmit}>
        <label>
          <span>Name</span>
          <input type="text" bind:value={name} required placeholder="Your name" />
        </label>
        <label>
          <span>Email</span>
          <input type="email" bind:value={email} required placeholder="you@example.com" />
        </label>
        <label>
          <span>Message</span>
          <textarea bind:value={message} required rows={5} placeholder="What's on your mind?"></textarea>
        </label>
        {#if status === 'error'}
          <p class="error">{errorMsg}</p>
        {/if}
        <button type="submit" disabled={status === 'sending'}>
          {status === 'sending' ? 'Sending…' : 'Send message'}
        </button>
      </form>
    {/if}
  </div>
</div>

<style>
  .contact-wrap {
    padding: var(--sec-pt, 2.5rem) 1.5rem var(--sec-pb, 1.5rem);
  }

  .inner {
    max-width: 560px;
    margin: 0 auto;
  }

  h2 {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--text);
    margin: 0 0 1.5rem;
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  label span {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--muted);
  }

  input, textarea {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    padding: 0.625rem 0.75rem;
    font-size: 0.9375rem;
    font-family: inherit;
    outline: none;
    width: 100%;
    transition: border-color var(--transition);
  }

  input:focus, textarea:focus {
    border-color: var(--accent);
  }

  textarea { resize: vertical; }

  button[type="submit"] {
    align-self: flex-start;
    padding: 0.75rem 2rem;
    background: var(--accent);
    color: #fff;
    font-weight: 600;
    font-size: 0.9375rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    border: none;
    transition: background var(--transition);
    font-family: inherit;
  }

  button[type="submit"]:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  button[type="submit"]:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .success {
    color: #10b981;
    font-size: 1rem;
    margin: 0;
  }

  .error {
    color: #f43f5e;
    font-size: 0.875rem;
    margin: 0;
  }
</style>
