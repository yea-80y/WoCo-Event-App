<script lang="ts">
  /**
   * The rider's surface for one coaster: the card, and the two facts a
   * first-time rider needs before tapping it.
   *
   * DELIBERATELY THIN. Someone reaches this from a QR code on a lanyard, in a
   * queue, on a phone, and may be a child. Everything here has to earn its
   * place against that.
   *
   * It renders inside the ordinary attendee shell, and that is a decision
   * rather than an accident: a rider who has just made their first credit is a
   * WoCo user, and the nav is how they reach the passport holding it. A version
   * of this page with the chrome stripped off was built and dropped — it saved
   * a rider three rows they could ignore, and cost them every way out.
   *
   * THE CATALOGUE GATE IS LOAD-BEARING, not hygiene. `CoasterCredit` will
   * happily render a working collect button for a subject nothing defines
   * ("Unknown coaster", the hash as a park name), so mounting it ungated would
   * let anyone mint a subject id, craft a link, and have riders signing real
   * statements against an invented coaster under this page's chrome. The
   * verification page refuses the same thing for the same reason.
   *
   * VOCABULARY IS LOAD-BEARING. A CREDIT is a coaster ridden once, ever;
   * repeat rides are LAPS. A rider's feed is their LOGBOOK. No crypto words
   * anywhere a fan reads — collect and keepsake, never wallet or mint.
   */
  import { onMount } from "svelte";
  import { lookupSubject, currentEra, WOCO_SUBJECTS, type Hex0x } from "@woco/shared";
  import CoasterCredit from "./CoasterCredit.svelte";
  import { creditsUnlocked } from "./credits.js";
  import { navigate } from "../router/router.svelte.js";

  interface Props {
    /** Subject hash from the route. Unknown or malformed is a real state. */
    subject?: string;
  }

  let { subject = "" }: Props = $props();

  const normalised = $derived(subject.trim().toLowerCase() as Hex0x);
  const definition = $derived(lookupSubject(WOCO_SUBJECTS, normalised));
  const known = $derived(definition !== null);
  const era = $derived(definition ? currentEra(definition) : null);

  /**
   * Whether this device has already been set up, so the steps below are shown
   * to the person who needs them and nobody else.
   *
   * Starts TRUE so they never flash at a returning rider before the check
   * resolves — `creditsUnlocked` asks only what is already stored and never
   * prompts, so the answer arrives in a tick.
   */
  let started = $state(true);

  onMount(async () => {
    started = await creditsUnlocked();
  });
</script>

<section class="page">
  <p class="kicker kicker--plain">Coaster credits</p>

  {#if !known}
    <p class="refuse">This link doesn't point to a coaster we list.</p>
  {:else}
    <CoasterCredit subject={normalised} />

    {#if !started}
      <!-- The whole of what a first-timer has to do, in the order they do it.
           Shown only until this device is set up. The previous version of this
           page said "Ride it once to add the credit" and nothing else, which
           does not tell someone that the first tap opens a sign-in, how long
           that takes, or that tapping with no signal still works — and every
           one of those is a reason to give up on the first screen. -->
      <div class="start">
        <h2>First time here?</h2>
        <ol>
          <li><strong>Tap "I rode it"</strong> after your lap.</li>
          <li>
            You'll be asked to <strong>set up your logbook</strong> the first time.
            A passkey is quickest - one tap, no password and no email.
          </li>
          <li>After that, every tap adds a lap and saves the time.</li>
        </ol>
        <p class="start-note">
          <strong>No signal?</strong> Tap anyway. Laps are saved on your phone with the
          right time and send themselves when you're back online.
        </p>
      </div>
    {/if}

    <!-- The single most valuable sentence here for a parent watching a child
         use it, and a commitment the plan makes rather than a reassurance we
         invented: this rail collects no email from anyone, at any age.
         "Logging laps never needs an email" rather than the older "No email,
         ever": email IS one of the ways to sign in, so the unqualified promise
         had become untrue at exactly the screen that makes it. -->
    <p class="footnote">
      Your laps and times live in your logbook - private unless you publish your count.
      Logging laps never needs an email.
    </p>

    {#if started}
      <!-- Only once there is something to look at. A rider mid-ride does not
           need a second destination, and a brand-new one has an empty passport.

           A BUTTON CALLING `navigate`, NEVER `<a href="#/tickets">`. The deploy
           injects `<base href="https://gateway.woco-net.com/bzz/{hash}/">` so
           the bundle's assets resolve, and a fragment-only href resolves
           against the BASE — so the anchor navigated the rider off
           woco.eth.limo and onto the gateway origin. That is not cosmetic: the
           WebAuthn RP ID is taken from `window.location.hostname`
           (`resolvePasskeyRpId`), so a passkey on the gateway host is a
           DIFFERENT ACCOUNT, and the rider's credits are not there. `navigate`
           sets `window.location.hash` and cannot leave the origin. -->
      <p class="footnote">
        <button class="linkish" onclick={() => navigate("/tickets")}>
          Your passport - every credit you hold
        </button>
      </p>
    {/if}

    <!-- The public counter is the marketing asset, and this is the loop into
         it. Relative, because the app is served from a content hash whose path
         prefix is not known at build time. -->
    <!-- Deliberately a real link: the counter is a SEPARATE page in the same
         Swarm collection, so it has to resolve against the base like every
         other asset. It is a different document, not a route, so there is no
         origin change to worry about mid-session. -->
    <p class="footnote">
      <a href="verify.html?subject={normalised}">
        See the public count for {era?.name ?? "this coaster"}
      </a>
    </p>
  {/if}
</section>

<style>
  .page {
    max-width: 32rem;
    margin: 0 auto;
    padding: 1.5rem 1.25rem 3rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .refuse {
    margin: 0;
    color: var(--text-secondary);
    line-height: 1.6;
  }

  .start {
    padding: 1rem 1.125rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .start h2 {
    margin: 0 0 0.625rem;
    font-family: var(--font-display);
    font-size: 1rem;
    color: var(--text);
  }

  .start ol {
    margin: 0;
    padding-left: 1.125rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .start li {
    font-size: 0.875rem;
    line-height: 1.5;
    color: var(--text-secondary);
  }

  .start strong { color: var(--text); }

  .start-note {
    margin: 0.875rem 0 0;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
    font-size: 0.8125rem;
    line-height: 1.5;
    color: var(--text-secondary);
  }

  .footnote {
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.55;
    color: var(--text-muted);
  }

  .footnote a,
  .footnote .linkish {
    color: var(--accent-text);
    border-bottom: 1px solid var(--accent);
    text-decoration: none;
  }
  .footnote a:hover,
  .footnote .linkish:hover { color: var(--accent); }

  /* A route change, so a button — but it reads as the link it replaces. */
  .linkish {
    padding: 0;
    background: none;
    border-left: none;
    border-right: none;
    border-top: none;
    font: inherit;
    cursor: pointer;
  }
</style>
