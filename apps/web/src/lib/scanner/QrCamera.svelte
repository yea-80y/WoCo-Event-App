<script lang="ts">
  /**
   * Thin camera wrapper around qr-scanner. Emits every decoded payload;
   * debouncing/dedup is the parent's job (it knows the scan semantics).
   */
  import { onMount } from "svelte";
  import QrScanner from "qr-scanner";

  let { onScan, paused = false }: { onScan: (data: string) => void; paused?: boolean } = $props();

  let videoEl: HTMLVideoElement;
  let error = $state<string | null>(null);
  let starting = $state(true);
  let instance: QrScanner | null = null;

  onMount(() => {
    instance = new QrScanner(videoEl, (result) => onScan(result.data), {
      returnDetailedScanResult: true,
      preferredCamera: "environment",
      maxScansPerSecond: 8,
      highlightScanRegion: true,
      highlightCodeOutline: true,
    });
    instance
      .start()
      .then(() => (starting = false))
      .catch((err: unknown) => {
        starting = false;
        error =
          err instanceof Error && /denied|permission/i.test(err.message)
            ? "Camera access denied — allow camera for this site, or use manual entry below."
            : "Could not start the camera. Use manual entry below.";
      });
    return () => {
      instance?.destroy();
      instance = null;
    };
  });

  $effect(() => {
    if (!instance || starting) return;
    if (paused) instance.pause();
    else void instance.start();
  });
</script>

<div class="camera">
  <!-- svelte-ignore a11y_media_has_caption -->
  <video bind:this={videoEl} playsinline></video>
  {#if starting}
    <div class="overlay">Starting camera…</div>
  {:else if error}
    <div class="overlay error">{error}</div>
  {/if}
</div>

<style>
  .camera {
    position: relative;
    width: 100%;
    height: 100%;
    background: #000;
    overflow: hidden;
  }
  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 1.5rem;
    color: var(--text-secondary);
    font-size: 0.9375rem;
    background: rgba(11, 11, 9, 0.85);
  }
  .overlay.error {
    color: var(--warning);
  }
</style>
