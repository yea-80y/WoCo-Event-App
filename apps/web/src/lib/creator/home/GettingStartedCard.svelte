<script lang="ts">
  /**
   * Persistent "Getting started" checklist on CreatorHome. Step completion is
   * derived from data the home screen already loads (stripeReady, events,
   * sites) plus the onboarding record (audience import). Ordering follows the
   * welcome answer: existing organisers see the audience import right after
   * Stripe; fresh starters don't see it at all.
   */
  import { onboarding } from "./onboarding.svelte.js";
  import { navigate } from "../../router/router.svelte.js";
  import StripeConnectModal from "../dashboard/StripeConnectModal.svelte";
  import Check from "lucide-svelte/icons/check";
  import ArrowRight from "lucide-svelte/icons/arrow-right";

  interface Props {
    stripeReady: boolean | null;
    eventsCount: number;
    sitesCount: number;
  }
  let { stripeReady, eventsCount, sitesCount }: Props = $props();

  let stripeModalOpen = $state(false);
  let stripeConnected = $state(false);

  interface Step {
    id: string;
    label: string;
    desc: string;
    done: boolean;
    action: () => void;
  }

  const steps = $derived.by<Step[]>(() => {
    const stripe: Step = {
      id: "stripe",
      label: "Verify with Stripe",
      desc: "Unlocks paid events, card payouts, free site hosting and email broadcasts.",
      done: stripeReady === true || stripeConnected,
      action: () => { stripeModalOpen = true; },
    };
    const audience: Step = {
      id: "audience",
      label: "Bring your audience across",
      desc: "Export your attendee CSV from Skiddle, Fatsoma or RA and import it here.",
      done: onboarding.record.importedAudience,
      action: () => navigate("/creator/audience"),
    };
    const event: Step = {
      id: "event",
      label: "Create your first event",
      desc: "Backend, branding, pages, deploy — the four-step builder.",
      done: eventsCount > 0,
      action: () => navigate("/site-builder"),
    };
    const site: Step = {
      id: "site",
      label: "Build your website",
      desc: "Your venue's own site with events embedded — free hosting once verified.",
      done: sitesCount > 0,
      action: () => navigate("/creator/sites"),
    };
    const answer = onboarding.record.hostsElsewhere;
    if (answer === "yes") return [stripe, audience, event, site];
    if (answer === "no") return [stripe, event, site];
    return [stripe, event, site, audience];
  });

  const doneCount = $derived(steps.filter((s) => s.done).length);
  const allDone = $derived(doneCount === steps.length);
</script>

{#if !allDone}
  <section class="block getting-started">
    <header class="gs-head">
      <div>
        <span class="gs-kicker mono"><span class="gs-tag">00 //</span> GETTING STARTED</span>
        <h2>Set up your studio</h2>
      </div>
      <div class="gs-meta">
        <span class="gs-progress mono">{doneCount}/{steps.length}</span>
        <button class="gs-hide mono" onclick={() => onboarding.dismiss()} title="Hide this guide">Hide guide</button>
      </div>
    </header>

    <ol class="gs-steps">
      {#each steps as step (step.id)}
        <li>
          <button class="gs-step" class:done={step.done} onclick={step.action} disabled={step.done}>
            <span class="gs-tick" aria-hidden="true">
              {#if step.done}<Check size={13} strokeWidth={3} />{/if}
            </span>
            <span class="gs-body">
              <span class="gs-label">{step.label}</span>
              <span class="gs-desc">{step.desc}</span>
            </span>
            {#if !step.done}
              <span class="gs-go"><ArrowRight size={15} strokeWidth={2.5} /></span>
            {/if}
          </button>
        </li>
      {/each}
    </ol>
  </section>
{/if}

<StripeConnectModal
  bind:open={stripeModalOpen}
  onconnected={() => { stripeConnected = true; }}
  onclose={() => { stripeModalOpen = false; }}
/>

<style>
  .getting-started {
    margin-bottom: 3rem;
  }

  .gs-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .gs-kicker {
    font-size: 0.6875rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-muted);
  }

  .gs-tag {
    color: var(--accent);
    font-weight: 700;
  }

  .gs-head h2 {
    font-size: 1.375rem;
    margin: 0.5rem 0 0;
    letter-spacing: -0.025em;
  }

  .gs-meta {
    display: flex;
    align-items: center;
    gap: 0.875rem;
  }

  .gs-progress {
    font-size: 0.8125rem;
    font-weight: 700;
    color: var(--accent);
    letter-spacing: 0.06em;
  }

  .gs-hide {
    font-size: 0.6875rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    transition: color var(--transition);
  }

  .gs-hide:hover {
    color: var(--text);
  }

  .gs-steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .gs-step {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 0.875rem;
    width: 100%;
    padding: 0.875rem 1rem;
    text-align: left;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius-sm);
    transition: border-color var(--transition), background var(--transition);
  }

  .gs-step:not(:disabled):hover {
    border-color: var(--border-hover);
    border-left-color: var(--accent-hover);
    background: var(--bg-surface-hover);
  }

  .gs-step.done {
    border-left-color: var(--border);
    opacity: 0.6;
    cursor: default;
  }

  .gs-tick {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.375rem;
    height: 1.375rem;
    flex-shrink: 0;
    border: 1.5px solid var(--border-hover);
    border-radius: 50%;
    color: var(--accent-ink);
  }

  .gs-step.done .gs-tick {
    background: var(--accent);
    border-color: var(--accent);
  }

  .gs-body {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }

  .gs-label {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
  }

  .gs-step.done .gs-label {
    text-decoration: line-through;
    text-decoration-thickness: 1px;
  }

  .gs-desc {
    font-size: 0.8125rem;
    color: var(--text-muted);
    line-height: 1.4;
  }

  .gs-go {
    display: inline-flex;
    color: var(--accent);
  }
</style>
