<script lang="ts">
  export const GATEWAYS = [
    { id: "woco",    label: "WoCo gateway (default)", url: "https://gateway.woco-net.com", default: true },
    // { id: "etherna", label: "Etherna gateway",        url: "https://gateway.etherna.io"   }, // P5
  ] as const;

  interface Props { value: string; }
  let { value = $bindable(GATEWAYS.find(g => g.default)?.url ?? GATEWAYS[0].url) }: Props = $props();
</script>

<select class="gw-select" bind:value>
  {#each GATEWAYS as gw}
    <option value={gw.url}>{gw.label}</option>
  {/each}
</select>

<style>
  .gw-select {
    width: 100%;
    padding: 0.625rem 0.875rem;
    background: var(--bg-input, var(--bg-surface));
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 0.9375rem;
    font-family: inherit;
    cursor: pointer;
    transition: border-color var(--transition);
    appearance: auto;
  }
  .gw-select:focus { outline: none; border-color: var(--accent); }
</style>
