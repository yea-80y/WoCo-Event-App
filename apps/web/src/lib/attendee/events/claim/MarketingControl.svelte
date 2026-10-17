<script lang="ts">
  /**
   * The checkout's marketing control, in the mode the organiser's confirmed notice
   * sets (claim-status, 2026-10-14):
   *   - consent:    an unticked "Email me..." box. Ticked = consent.
   *   - own-events: a sentence naming the organiser, and an unticked "Don't email
   *                 me" box. Left alone = the PECR soft opt-in; ticked = no.
   * Never pre-ticked in either mode. The wording is given, not built here: the
   * caller sends create-checkout the same object it passes in, so the text shown
   * is the text the server compares with its own (2026-10-15).
   */
  import type { MarketingWording } from "@woco/shared";

  interface Props {
    wording: MarketingWording;
    ticked: boolean;
    onTickedChange: (ticked: boolean) => void;
  }

  let { wording, ticked, onTickedChange }: Props = $props();
</script>

{#if wording.sentence}
  <p class="marketing-sentence">{wording.sentence}</p>
{/if}
<label class="marketing-row">
  <input
    type="checkbox"
    checked={ticked}
    onchange={(e) => onTickedChange((e.target as HTMLInputElement).checked)}
  />
  <span>{wording.box}</span>
</label>

<style>
  .marketing-sentence {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.45;
    color: var(--text);
  }

  .marketing-row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    cursor: pointer;
    font-size: 0.75rem;
    line-height: 1.45;
    color: var(--text);
  }

  .marketing-row input[type="checkbox"] {
    width: 0.875rem;
    height: 0.875rem;
    margin-top: 0.125rem;
    flex-shrink: 0;
    accent-color: var(--accent);
  }
</style>
