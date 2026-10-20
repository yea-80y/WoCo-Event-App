<script lang="ts">
  import { encode } from "uqr";

  /** The code a device shows for the main one to scan or type (#746 step 4). Dark on
   *  light whatever the theme: WoCo's scanner reads only that way round. */
  let { qr, typed }: { qr: string; typed: string } = $props();

  const matrix = $derived.by(() => {
    const { data } = encode(qr, { ecc: "M", border: 2 });
    let path = "";
    for (let y = 0; y < data.length; y++) {
      for (let x = 0; x < data.length; x++) if (data[y][x]) path += `M${x} ${y}h1v1h-1z`;
    }
    return { size: data.length, path };
  });

  // Typing it is as real a path as scanning it, so it is as big as the QR. Lines break
  // only between groups; the text selected or copied is still exactly `typed`.
  const groups = $derived(typed.split("-"));
</script>

<svg class="qr" viewBox="0 0 {matrix.size} {matrix.size}" shape-rendering="crispEdges" role="img" aria-label="Code for your other device">
  <rect width={matrix.size} height={matrix.size} class="paper" />
  <path d={matrix.path} class="ink" />
</svg>
<p class="code">{#each groups as g, i}{#if i > 0}-<wbr />{/if}<span class="group">{g}</span>{/each}</p>

<style>
  .qr {
    width: min(16rem, 100%);
    height: auto;
    border-radius: var(--radius-md);
  }
  .paper {
    fill: var(--text);
  }
  .ink {
    fill: var(--bg);
  }
  /* The QR's width, so the groups wrap two to a line under it, on a 320px screen too. */
  .code {
    margin: 0;
    max-width: min(16rem, 100%);
    font-family: var(--font-mono);
    font-size: 1.75rem;
    font-weight: 600;
    line-height: 1.35;
    letter-spacing: 0.06em;
    color: var(--text);
  }
  .group {
    white-space: nowrap;
  }
</style>
