<!--
  The one thing to do next, drawn as a ticket stub: the step on the left, and
  past the perforation where it sits in setup (or what it is about, once setup
  is done). Display only. Which step to show is `next-step.ts`, and every action
  is the dashboard's, so this file never reads or decides anything.
-->
<script lang="ts">
  import { SETUP_STEPS, type NextStep } from "./next-step.js";
  import NavIcon from "../../components/nav/NavIcon.svelte";

  interface Props {
    step: NextStep;
    /** Verify / continue with Stripe (opens the Stripe flow). */
    onstripe: () => void;
    /** Where Stripe shows what it still needs once the account is set up. */
    onstripedetails: () => void;
    onretry: () => void;
    onname: () => void;
    onimport: () => void;
    onskipimport: () => void;
    onfirstevent: () => void;
    ondoors: (eventId: string) => void;
  }
  let { step, onstripe, onstripedetails, onretry, onname, onimport, onskipimport, onfirstevent, ondoors }: Props = $props();

  interface View {
    title: string;
    text: string;
    action?: { label: string; run: () => void; quiet?: boolean };
    secondary?: { label: string; run: () => void };
    /** Setup position, or a word for what the card is about. */
    setup?: (typeof SETUP_STEPS)[number];
    about?: string;
  }

  const UNAVAILABLE: Record<string, { title: string; text: string; about: string }> = {
    stripe: {
      title: "Couldn't check your Stripe account",
      text: "Stripe didn't answer just now, so you haven't been moved on. Nothing on your account has changed.",
      about: "Stripe",
    },
    name: {
      title: "Couldn't check your name",
      text: "We couldn't confirm whether your name is ready to claim, so you haven't been moved on.",
      about: "Your name",
    },
    audience: {
      title: "Couldn't check for an attendee list",
      text: "Try again, or skip this step if you're starting fresh.",
      about: "Attendees",
    },
    events: {
      title: "Couldn't load your events",
      text: "They're not lost. Try again in a moment.",
      about: "Events",
    },
  };

  function timeOf(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  const view = $derived.by<View | null>(() => {
    switch (step.kind) {
      case "stripe-start":
        return {
          setup: "stripe",
          title: "Verify with Stripe",
          text: "Stripe checks who you are and where your money goes. You can sell tickets once it's done.",
          action: { label: "Verify with Stripe", run: onstripe },
        };
      case "stripe-review":
        return {
          setup: "stripe",
          title: "Stripe is checking your details",
          text: "There's nothing for you to do. You'll move on to the next step as soon as Stripe confirms.",
          action: { label: "Check again", run: onretry, quiet: true },
        };
      case "stripe-more":
        return {
          about: "Stripe",
          title: "Stripe needs more details",
          text: "Stripe has asked for more information about you or your business. Send it so your payments and payouts keep going.",
          action: { label: "See what Stripe needs", run: onstripedetails },
        };
      case "name":
        return {
          setup: "name",
          title: "Claim your name",
          text: "Choose a name like yourclub.woco.eth. It becomes how people see you on WoCo.",
          action: { label: "Claim your name", run: onname },
        };
      case "import":
        return {
          setup: "import",
          title: "Bring your attendees across",
          text: "Sold tickets somewhere else before? Import that attendee list so you can tell them about your events here.",
          action: { label: "Import a list", run: onimport },
          secondary: { label: "Skip, I'm starting fresh", run: onskipimport },
        };
      case "first-event":
        return {
          setup: "first-event",
          title: "Put your first event on sale",
          text: "Add the date, the tickets and the prices, then publish when you're ready.",
          action: { label: "Create an event", run: onfirstevent },
        };
      case "doors": {
        const at = timeOf(step.event.startDate);
        const id = step.event.eventId;
        return {
          about: "Today",
          title: "Doors open today",
          text: `${step.event.title}${at ? ` starts at ${at}` : " is on today"}. Get the door scanner ready from the event page.`,
          action: { label: "Open the event", run: () => ondoors(id) },
        };
      }
      case "unavailable": {
        const u = UNAVAILABLE[step.check];
        return {
          about: u.about,
          title: u.title,
          text: u.text,
          action: { label: "Try again", run: onretry, quiet: true },
          secondary: step.check === "audience" ? { label: "Skip, I'm starting fresh", run: onskipimport } : undefined,
        };
      }
      default:
        return null;
    }
  });

  const position = $derived(view?.setup ? SETUP_STEPS.indexOf(view.setup) + 1 : 0);
</script>

{#if view}
  <section class="stub" aria-label="Next step">
    <div class="stub-main">
      <h2>{view.title}</h2>
      <p>{view.text}</p>
      {#if view.action || view.secondary}
        <div class="stub-actions">
          {#if view.action}
            <button
              class="btn"
              class:btn--primary={!view.action.quiet}
              class:btn--ghost={view.action.quiet}
              onclick={view.action.run}
            >{view.action.label}</button>
          {/if}
          {#if view.secondary}
            <button class="btn btn--text" onclick={view.secondary.run}>{view.secondary.label}</button>
          {/if}
        </div>
      {/if}
    </div>

    <div class="stub-side">
      {#if position > 0}
        <span class="pos" aria-label="Step {position} of {SETUP_STEPS.length}">
          <b>{position}</b><small>of {SETUP_STEPS.length}</small>
        </span>
      {:else}
        <span class="about">
          {#if view.about === "Today"}<NavIcon name="events" size={22} active />{/if}
          <small>{view.about}</small>
        </span>
      {/if}
    </div>
  </section>
{/if}

<style>
  /* The stub's perforation sits a fixed distance from the right edge, and the
     two bites are cut where it meets the top and bottom. */
  .stub {
    --side: 5.5rem;
    --bite: 0.5rem;
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--side);
    margin-bottom: 2.5rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    -webkit-mask:
      radial-gradient(circle var(--bite) at calc(100% - var(--side)) 0, transparent 98%, #000) top / 100% 51% no-repeat,
      radial-gradient(circle var(--bite) at calc(100% - var(--side)) 100%, transparent 98%, #000) bottom / 100% 51% no-repeat;
    mask:
      radial-gradient(circle var(--bite) at calc(100% - var(--side)) 0, transparent 98%, #000) top / 100% 51% no-repeat,
      radial-gradient(circle var(--bite) at calc(100% - var(--side)) 100%, transparent 98%, #000) bottom / 100% 51% no-repeat;
    animation: stub-in 0.3s var(--ease-out);
  }
  @keyframes stub-in { from { opacity: 0; transform: translateY(6px); } }

  .stub-main {
    display: grid;
    gap: 0.5rem;
    padding: 1.25rem 1.25rem 1.25rem 1.375rem;
    min-width: 0;
  }
  .stub-main h2 {
    font-size: 1.25rem;
    line-height: 1.2;
    text-wrap: balance;
  }
  .stub-main p {
    margin: 0;
    max-width: 52ch;
    color: var(--text-secondary);
    font-size: 0.9375rem;
    line-height: 1.5;
  }
  .stub-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
    margin-top: 0.5rem;
  }

  .stub-side {
    display: grid;
    place-items: center;
    padding: 1rem 0.5rem;
    border-left: 1px dashed var(--border-hover);
    text-align: center;
  }
  .pos, .about { display: grid; justify-items: center; gap: 0.25rem; }
  .pos b {
    font-family: var(--font-mono);
    font-size: 2rem;
    font-weight: 700;
    line-height: 1;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .pos small, .about small { font-size: 0.75rem; color: var(--text-muted); }
  .about { color: var(--accent-text); }

  @media (max-width: 480px) {
    .stub { --side: 4.25rem; }
    .stub-main { padding: 1rem; }
    .stub-main h2 { font-size: 1.125rem; }
    .pos b { font-size: 1.625rem; }
  }

  @media (prefers-reduced-motion: reduce) {
    .stub { animation: none; }
  }
</style>
