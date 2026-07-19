<script lang="ts">
  /**
   * One-time welcome for a first creator-portal visit. Asks the single question
   * that personalises the Getting Started checklist (existing attendees on
   * another platform → the audience-import step is promoted). Two taps max —
   * the checklist card does the actual guiding.
   */
  import { onboarding } from "./onboarding.svelte.js";

  interface Props {
    open?: boolean;
  }
  let { open = $bindable(false) }: Props = $props();

  function answer(hostsElsewhere: "yes" | "no") {
    onboarding.answerWelcome(hostsElsewhere);
    open = false;
  }

  function skip() {
    onboarding.skipWelcome();
    open = false;
  }

  function handleBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) skip();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && open) skip();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal-backdrop" role="presentation" onclick={handleBackdrop}>
    <div class="modal" role="dialog" aria-modal="true" aria-label="Welcome to your studio">
      <span class="kicker mono">STUDIO // WELCOME</span>
      <h2>Let's get you set up.</h2>
      <p class="lede">
        One quick question so we can point you at the right first steps —
        your setup guide lives on this page whenever you want it.
      </p>

      <p class="question">Do you already run events on another platform?</p>
      <p class="question-hint">Skiddle, Fatsoma, RA, Eventbrite…</p>

      <div class="answers">
        <button class="answer answer--primary" onclick={() => answer("yes")}>
          Yes — I have existing attendees
          <span class="answer-sub">We'll help you bring your marketing list across</span>
        </button>
        <button class="answer" onclick={() => answer("no")}>
          No — starting fresh
          <span class="answer-sub">We'll walk you through your first event</span>
        </button>
      </div>

      <button class="skip mono" onclick={skip}>Skip for now</button>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 500;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.25rem;
    background: rgba(8, 8, 7, 0.72);
    backdrop-filter: blur(3px);
  }

  .modal {
    width: 100%;
    max-width: 26rem;
    padding: 1.75rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
  }

  .kicker {
    font-size: 0.6875rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    color: var(--accent);
  }

  h2 {
    margin: 0.5rem 0 0;
    font-size: 1.5rem;
    letter-spacing: -0.025em;
  }

  .lede {
    margin: 0.625rem 0 0;
    font-size: 0.875rem;
    color: var(--text-muted);
    line-height: 1.5;
  }

  .question {
    margin: 1.5rem 0 0;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
  }

  .question-hint {
    margin: 0.125rem 0 0;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .answers {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.875rem;
  }

  .answer {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.875rem 1rem;
    text-align: left;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    transition: border-color var(--transition), background var(--transition);
  }

  .answer:hover {
    border-color: var(--accent);
    background: var(--bg-surface-hover);
  }

  .answer--primary {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  }

  .answer-sub {
    font-size: 0.75rem;
    font-weight: 400;
    color: var(--text-muted);
  }

  .skip {
    margin-top: 1.125rem;
    align-self: center;
    font-size: 0.6875rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    transition: color var(--transition);
  }

  .skip:hover {
    color: var(--text);
  }
</style>
