<!--
  CohortStamp — the campaign's signature mark. A notary-style stamp strike:
  the on-chain cohort attestation rendered as the physical object it replaces.
  Ring text carries the cohort, the centre numeral is the epoch. Drawn inline
  (currentColor + tokens) so it inherits any surface it lands on.
-->
<script lang="ts">
  let {
    epoch = 0,
    size = 72,
  }: { epoch?: number; size?: number } = $props();

  const label = $derived(
    epoch === 0 ? "EARLY ADOPTER • WOCO • ON-CHAIN • " : `COHORT ${epoch} • WOCO • ON-CHAIN • `,
  );
  const uid = $derived(`stamp-ring-${epoch}-${size}`);
</script>

<svg
  class="stamp"
  width={size}
  height={size}
  viewBox="0 0 100 100"
  role="img"
  aria-label={epoch === 0 ? "Early adopter badge — epoch 0" : `Cohort badge — epoch ${epoch}`}
>
  <defs>
    <path id={uid} d="M 50,50 m -33,0 a 33,33 0 1,1 66,0 a 33,33 0 1,1 -66,0" />
  </defs>

  <!-- perforated outer edge -->
  <circle cx="50" cy="50" r="47" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.5 3.5" />
  <!-- solid inner seal -->
  <circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" stroke-width="2" />
  <circle cx="50" cy="50" r="24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.55" />

  <text class="ring-text" fill="currentColor">
    <textPath href="#{uid}" startOffset="0">{label}</textPath>
  </text>

  <text class="epoch-num" x="50" y="50" text-anchor="middle" dominant-baseline="central" fill="currentColor">
    E{epoch}
  </text>
</svg>

<style>
  .stamp {
    color: var(--accent);
    transform: rotate(-8deg);
    flex-shrink: 0;
  }
  .ring-text {
    font-family: var(--font-mono);
    font-size: 8.5px;
    letter-spacing: 0.22em;
    font-weight: 600;
  }
  .epoch-num {
    font-family: var(--font-tag);
    font-size: 19px;
  }
</style>
