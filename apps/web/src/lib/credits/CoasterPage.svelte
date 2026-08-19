<script lang="ts">
  /**
   * The rider's surface for one coaster: the card, and the two facts a
   * first-time rider needs before tapping it.
   *
   * DELIBERATELY THIN. Someone reaches this from a QR code on a lanyard, in a
   * queue, on a phone, and may be a child. Everything here has to earn its
   * place against that: a card, one line about where their credits live, and
   * one link out to the public count. The sibling verification page was
   * rewritten in this same branch for having far too many words — this page
   * does not get to repeat that.
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
  import { lookupSubject, WOCO_SUBJECTS, type Hex0x } from "@woco/shared";
  import CoasterCredit from "./CoasterCredit.svelte";

  interface Props {
    /** Subject hash from the route. Unknown or malformed is a real state. */
    subject?: string;
  }

  let { subject = "" }: Props = $props();

  const normalised = $derived(subject.trim().toLowerCase() as Hex0x);
  const known = $derived(lookupSubject(WOCO_SUBJECTS, normalised) !== null);
</script>

<section class="page">
  <p class="kicker kicker--plain">Coaster credits</p>

  {#if !known}
    <p class="refuse">This link doesn't point to a coaster we list.</p>
  {:else}
    <CoasterCredit subject={normalised} />

    <!-- The single most valuable sentence here for a parent watching a child
         use it, and a commitment the plan makes rather than a reassurance we
         invented: this rail collects no email from anyone, at any age. -->
    <p class="footnote">
      Your credits live in your logbook — private unless you publish them. No email, ever.
    </p>

    <!-- The public counter is the marketing asset, and this is the loop into
         it. Relative, because the app is served from a content hash whose path
         prefix is not known at build time. -->
    <p class="footnote">
      <a href="verify.html?subject={normalised}">See the public count for this coaster</a>
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

  .footnote {
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.55;
    color: var(--text-muted);
  }

  .footnote a {
    color: var(--accent-text);
    border-bottom: 1px solid var(--accent);
    text-decoration: none;
  }
  .footnote a:hover { color: var(--accent); }
</style>
