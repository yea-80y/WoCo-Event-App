<script lang="ts">
  /**
   * The audience split by how strong the permission behind each contact is —
   * and the filter control for the list below it.
   *
   * Why a proportional bar rather than the stat tiles this replaced: the tiles
   * counted reach (contacts / reachable / unsubscribed). The thing an organiser
   * is actually exposed on is permission STRENGTH, and "two thirds of my list
   * rests on a warranty I signed rather than a box anyone ticked" is a spatial
   * fact, not a numeric one. Klaviyo and Mailchimp both surface the same middle
   * state per contact; neither shows the shape of the whole list, which is the
   * question an organiser has before they press send.
   *
   * The three bands are distinguished by TEXTURE as well as hue — a 2% band is
   * a few pixels wide, where colour alone reads as noise.
   */
  import type { ContactConsentState } from "@woco/shared";

  interface Props {
    counts: Record<ContactConsentState, number>;
    /** null = no filter, show everyone. */
    filter: ContactConsentState | null;
    onFilter: (next: ContactConsentState | null) => void;
  }

  let { counts, filter, onFilter }: Props = $props();

  const BANDS: Array<{ state: ContactConsentState; label: string; note: string }> = [
    {
      state: "opted-in",
      label: "Opted in",
      note: "They ticked the box themselves at checkout. You can show exactly what they agreed to and when.",
    },
    {
      state: "imported",
      label: "Imported",
      note: "On your list under the warranty you gave at import. Mailable, but there is no record of this person agreeing — treat with care.",
    },
    {
      state: "unsubscribed",
      label: "Unsubscribed",
      note: "Never mailed, whatever you upload. Kept so a re-import cannot undo their choice.",
    },
  ];

  const total = $derived(BANDS.reduce((n, b) => n + counts[b.state], 0));
  const active = $derived(BANDS.find((b) => b.state === filter) ?? null);

  /** Below this a band is invisible, so floor it — a band you cannot see is a
   *  band you cannot click, and every one of these is worth clicking. */
  const MIN_BAND_PCT = 1.5;

  function width(n: number): string {
    if (total === 0 || n === 0) return "0%";
    return `${Math.max(MIN_BAND_PCT, (n / total) * 100)}%`;
  }
</script>

<section class="ledger" aria-label="Audience by consent">
  <div class="bar" aria-hidden="true">
    {#each BANDS as b (b.state)}
      <span
        class="band band--{b.state}"
        class:muted={filter !== null && filter !== b.state}
        style:width={width(counts[b.state])}
      ></span>
    {/each}
  </div>

  <div class="keys">
    {#each BANDS as b (b.state)}
      <button
        type="button"
        class="key key--{b.state}"
        class:on={filter === b.state}
        aria-pressed={filter === b.state}
        disabled={counts[b.state] === 0}
        onclick={() => onFilter(filter === b.state ? null : b.state)}
      >
        <span class="swatch" aria-hidden="true"></span>
        <span class="n">{counts[b.state].toLocaleString()}</span>
        <span class="l">{b.label}</span>
      </button>
    {/each}
  </div>

  <p class="note">
    {#if active}
      {active.note}
      <button type="button" class="clear" onclick={() => onFilter(null)}>Show all</button>
    {:else}
      {total.toLocaleString()} contacts. Pick a band to filter the list.
    {/if}
  </p>
</section>

<style>
  .ledger {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 0.875rem 1rem 0.75rem;
    background: var(--bg-surface);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .bar {
    display: flex;
    height: 10px;
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--bg-input);
  }

  .band {
    transition: width var(--transition), opacity var(--transition);
  }
  .band.muted { opacity: 0.28; }

  .band--opted-in { background: var(--accent); }
  .band--imported { background: var(--border-hover); }
  /* Hatched, not just red: reads as struck through, and survives a 2% width
     where a flat hue would just look like a stray pixel. */
  .band--unsubscribed {
    background: repeating-linear-gradient(
      135deg,
      var(--error-subtle) 0 3px,
      transparent 3px 6px
    ),
    var(--bg-elevated);
  }

  .keys {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .key {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    padding: 0.375rem 0.625rem;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    color: var(--text-secondary);
    transition: border-color var(--transition), color var(--transition), background var(--transition);
  }

  .key:hover:not(:disabled) { background: var(--bg-surface-hover); color: var(--text); }
  .key.on { border-color: var(--accent); color: var(--text); }
  .key:disabled { opacity: 0.4; cursor: default; }

  .swatch {
    width: 8px;
    height: 8px;
    border-radius: 1px;
    align-self: center;
    flex: none;
  }
  .key--opted-in .swatch { background: var(--accent); }
  .key--imported .swatch { background: var(--border-hover); }
  .key--unsubscribed .swatch {
    background: repeating-linear-gradient(135deg, var(--error) 0 2px, transparent 2px 4px);
  }

  .n {
    font-family: var(--font-mono);
    font-size: 0.9375rem;
    color: var(--text);
  }

  .l {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .note {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.5;
    color: var(--text-muted);
    max-width: 62ch;
  }

  .clear {
    color: var(--accent-text);
    font-size: 0.75rem;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .band { transition: none; }
  }
</style>
