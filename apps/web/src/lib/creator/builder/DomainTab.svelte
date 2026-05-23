<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    feedHash: string;
    onpublish: () => void;
    children?: Snippet;
  }

  let { feedHash, onpublish, children }: Props = $props();
</script>

{#if !feedHash}
  <div class="domain-empty">
    <div class="transform-visual" aria-hidden="true">
      <div class="url-row url-row--before">
        <span class="url-protocol">https://</span><span class="url-host url-host--dim">gateway.woco-net.com/bzz/</span><span class="url-hash">a3f9c2…</span>
      </div>
      <div class="arrow-wrap">
        <svg width="20" height="28" viewBox="0 0 20 28" fill="none">
          <line x1="10" y1="0" x2="10" y2="20" stroke="#C7F23A" stroke-width="1.5" stroke-dasharray="3 3"/>
          <path d="M4 16l6 8 6-8" stroke="#C7F23A" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        </svg>
      </div>
      <div class="url-row url-row--after">
        <span class="url-protocol url-protocol--after">https://</span><span class="url-host url-host--lime">mybar.com</span><span class="cursor">|</span>
      </div>
    </div>

    <div class="empty-copy">
      <p class="empty-headline">Connect your own address</p>
      <p class="empty-body">
        Give visitors a clean URL — <em>events.mybar.com</em> or <em>www.thevenue.co.uk</em> — instead of a long Swarm link.
        Takes about 5 minutes once your site is published.
      </p>
    </div>

    <div class="steps">
      <div class="empty-step">
        <div class="step-num">1</div>
        <div class="step-text">Publish your site using the button at the top right</div>
      </div>
      <div class="step-connector" aria-hidden="true"></div>
      <div class="empty-step empty-step--dim">
        <div class="step-num step-num--dim">2</div>
        <div class="step-text step-text--dim">Come back here to connect your domain</div>
      </div>
    </div>

    <button class="publish-cta" onclick={onpublish}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path d="M7 1v8M3.5 5.5L7 1l3.5 4.5M2 10.5h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Publish site first
    </button>
  </div>

{:else}
  <div class="domain-active">
    {@render children?.()}
  </div>
{/if}

<style>
  /* ── Empty state ─────────────────────────────────────────────── */
  .domain-empty {
    max-width: 26rem;
    margin: 3rem auto 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.25rem;
    padding: 0 1rem 3rem;
    text-align: center;
  }

  .transform-visual {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 1.25rem 1.5rem 1rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 6px;
    width: 100%;
    font-family: monospace;
    overflow: hidden;
  }

  .url-row { display: flex; align-items: baseline; font-size: 0.8125rem; max-width: 100%; overflow: hidden; }

  .url-protocol       { color: var(--text-muted); opacity: 0.5; }
  .url-protocol--after { opacity: 0.7; }
  .url-host--dim      { font-size: 0.75rem; color: var(--text-muted); opacity: 0.45; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .url-hash           { font-size: 0.75rem; color: var(--text-muted); opacity: 0.4; }
  .url-host--lime     { font-size: 1rem; font-weight: 700; color: #C7F23A; letter-spacing: -0.02em; }

  .cursor {
    color: #C7F23A;
    margin-left: 1px;
    animation: blink 1.1s step-end infinite;
  }

  .arrow-wrap { padding: 0.35rem 0; }
  .arrow-wrap svg { animation: bounce-down 2s ease-in-out infinite; }

  @keyframes blink        { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
  @keyframes bounce-down  { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(3px); } }

  .empty-copy       { display: flex; flex-direction: column; gap: 0.375rem; }
  .empty-headline   { font-size: 1rem; font-weight: 700; color: var(--text); margin: 0; letter-spacing: -0.02em; }
  .empty-body       { font-size: 0.8125rem; color: var(--text-muted); margin: 0; line-height: 1.6; }

  .empty-body em {
    font-style: normal;
    font-family: monospace;
    font-size: 0.85em;
    color: var(--text);
    background: color-mix(in srgb, #C7F23A 8%, var(--bg-elevated));
    border: 1px solid color-mix(in srgb, #C7F23A 18%, transparent);
    border-radius: 3px;
    padding: 0.1em 0.35em;
  }

  .steps          { display: flex; flex-direction: column; align-items: flex-start; width: 100%; }
  .empty-step     { display: flex; align-items: center; gap: 0.625rem; text-align: left; }
  .empty-step--dim { opacity: 0.5; }

  .step-num {
    width: 1.5rem; height: 1.5rem;
    border-radius: 50%;
    border: 1.5px solid #C7F23A;
    color: #C7F23A;
    font-size: 0.75rem; font-weight: 800;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .step-num--dim { border-color: var(--border); color: var(--text-muted); }

  .step-text     { font-size: 0.8125rem; color: var(--text); font-weight: 500; line-height: 1.4; }
  .step-text--dim { font-weight: 400; }

  .step-connector {
    width: 1.5rem;
    height: 1.25rem;
    flex-shrink: 0;
    display: flex;
    justify-content: center;
    position: relative;
  }
  .step-connector::before {
    content: '';
    position: absolute;
    inset: 0 50%;
    width: 1.5px;
    transform: translateX(-50%);
    background: linear-gradient(to bottom, color-mix(in srgb, #C7F23A 40%, transparent), var(--border));
  }

  .publish-cta {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.5rem 1.25rem;
    font-size: 0.875rem; font-weight: 700;
    background: #C7F23A; color: #0d0d0d;
    border-radius: 4px;
    letter-spacing: -0.01em;
    transition: background 130ms, transform 100ms;
    margin-top: 0.25rem;
  }
  .publish-cta:hover  { background: #d4f54d; transform: translateY(-1px); }
  .publish-cta:active { transform: translateY(0); }

  /* ── Active state ─────────────────────────────────────────────── */
  .domain-active {
    display: flex;
    flex-direction: column;
  }

  @media (max-width: 540px) {
    .domain-empty { margin-top: 1.5rem; }
  }
</style>
