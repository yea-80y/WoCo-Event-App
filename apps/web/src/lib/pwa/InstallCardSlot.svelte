<script lang="ts">
  import { onMount } from "svelte";
  import { router } from "../router/router.svelte.js";
  import { installPathExists, onInstallStateChange } from "./install-capture.js";
  import { INSTALL_ROUTES } from "./install-offer.js";

  /**
   * The bottom-of-page "Get the app" card on the home screens (the landing page,
   * attendee home, organiser dashboard). Eager and tiny, like InstallSlot: the
   * card's chunk is fetched only where an install is possible.
   */

  let installable = $state(installPathExists());
  onMount(() => onInstallStateChange(() => (installable = installPathExists())));
</script>

{#if installable && INSTALL_ROUTES.has(router.route)}
  {#await import("./InstallAppRow.svelte") then { default: InstallAppRow }}
    <InstallAppRow variant="card" />
  {/await}
{/if}
