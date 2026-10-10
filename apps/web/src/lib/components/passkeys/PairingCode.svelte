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
</script>

<svg class="qr" viewBox="0 0 {matrix.size} {matrix.size}" shape-rendering="crispEdges" role="img" aria-label="Code for your other device">
  <rect width={matrix.size} height={matrix.size} class="paper" />
  <path d={matrix.path} class="ink" />
</svg>
<p class="code">{typed}</p>

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
  .code {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 1.1rem;
    letter-spacing: 0.04em;
    color: var(--text);
    word-break: break-all;
  }
</style>
