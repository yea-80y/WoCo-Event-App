<script lang="ts">
  import { onMount } from "svelte";
  import { router } from "../router/router.svelte.js";
  import { installPathExists, onInstallStateChange } from "./install-capture.js";
  import { INSTALL_ROUTES } from "./install-offer.js";

  /**
   * Where the install offer may appear (the attendee home screens and the landing
   * page at /). Eager and tiny: the banner's chunk is fetched only where an install
   * is possible (a captured Chromium prompt, iOS, Firefox Android) on an offer
   * route, and re-checked when the prompt arrives. Every other rule is the banner's.
   */

  let installable = $state(installPathExists());
  onMount(() => onInstallStateChange(() => (installable = installPathExists())));
</script>

{#if installable && INSTALL_ROUTES.has(router.route)}
  {#await import("./InstallBanner.svelte") then { default: InstallBanner }}
    <InstallBanner />
  {/await}
{/if}
