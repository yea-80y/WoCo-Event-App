<!--
  CohortStamp — the campaign's signature mark. A notary-style stamp strike:
  the issuer-signed badge record rendered as the physical mark it replaces.
  Joined: ring text carries the cohort, the centre numeral is the epoch.
  Network: the centre is three linked marks, the A -> B -> C the badge is for.
  Drawn inline (currentColor + tokens) so it inherits any surface it lands on.
-->
<script lang="ts">
  import type { BadgeKind } from "@woco/shared";

  let {
    epoch = 0,
    size = 72,
    kind = "joined",
  }: { epoch?: number; size?: number; kind?: BadgeKind } = $props();

  const label = $derived(
    kind === "network"
      ? "NETWORK BUILDER • WOCO • SIGNED • "
      : epoch === 0 ? "EARLY ADOPTER • WOCO • SIGNED • " : `COHORT ${epoch} • WOCO • SIGNED • `,
  );
  const aria = $derived(
    kind === "network"
      ? "Network builder badge"
      : epoch === 0 ? "Early adopter badge — epoch 0" : `Cohort badge — epoch ${epoch}`,
  );
  const uid = $derived(`stamp-ring-${kind}-${epoch}-${size}`);
</script>

<svg
  class="stamp"
  class:stamp--network={kind === "network"}
  width={size}
  height={size}
  viewBox="0 0 100 100"
  role="img"
  aria-label={aria}
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

  {#if kind === "network"}
    <polyline points="38,58 50,42 62,58" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
    <circle cx="38" cy="58" r="4.5" fill="currentColor" />
    <circle cx="50" cy="42" r="4.5" fill="currentColor" />
    <circle cx="62" cy="58" r="4.5" fill="currentColor" />
  {:else}
    <text class="epoch-num" x="50" y="50" text-anchor="middle" dominant-baseline="central" fill="currentColor">
      E{epoch}
    </text>
  {/if}
</svg>

<style>
  .stamp {
    color: var(--accent);
    transform: rotate(-8deg);
    flex-shrink: 0;
  }
  .stamp--network {
    transform: rotate(6deg);
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
