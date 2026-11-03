<script lang="ts">
  /** The first question of creating an event (owner 2026-11-03): general admission or allocated seats. */
  import type { Admission } from "./seated-draft.js";

  interface Props { admission: Admission }
  let { admission = $bindable() }: Props = $props();

  const CROWD = [[8, 9], [19, 6], [31, 11], [44, 7], [12, 21], [25, 19], [37, 23], [48, 18], [6, 31], [20, 30], [33, 31], [46, 29]];
</script>

<fieldset class="admission">
  <legend>Seating</legend>
  <label class="route" class:on={admission === "general"}>
    <input type="radio" name="admission" value="general" bind:group={admission} />
    <svg width="56" height="36" viewBox="0 0 56 36" aria-hidden="true"><g fill="currentColor">{#each CROWD as [x, y], i (i)}<circle cx={x} cy={y} r="2.6" />{/each}</g></svg>
    <span><b>General admission</b><small>Standing or unreserved. You set how many tickets.</small></span>
  </label>
  <label class="route" class:on={admission === "seated"}>
    <input type="radio" name="admission" value="seated" bind:group={admission} />
    <svg width="56" height="36" viewBox="0 0 56 36" aria-hidden="true"><g fill="currentColor">{#each [7, 16, 25] as y (y)}{#each [6, 14, 22, 30, 38, 46] as x (x)}<rect x={x} y={y} width="5" height="5" rx="1" />{/each}{/each}</g></svg>
    <span><b>Allocated seats</b><small>Buyers pick their seat on a plan you draw.</small></span>
  </label>
</fieldset>

<style>
  .admission { border: 0; margin: 0; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }
  .admission legend { font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.4rem; padding: 0; }
  .route { position: relative; display: grid; grid-template-columns: auto 1fr; gap: 0.75rem; align-items: center; padding: 0.8rem; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-surface); color: var(--text-muted); cursor: pointer; }
  .route:hover { border-color: var(--border-hover); }
  .route.on { border-color: var(--accent); background: var(--accent-subtle); color: var(--text); }
  .route input { position: absolute; opacity: 0; pointer-events: none; }
  .route:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
  .route span { display: grid; gap: 0.15rem; }
  .route b { color: var(--text); font-size: 0.95rem; }
  .route small { color: var(--text-muted); font-size: 0.8rem; line-height: 1.35; }
  @media (max-width: 520px) { .admission { grid-template-columns: 1fr; } }
</style>
