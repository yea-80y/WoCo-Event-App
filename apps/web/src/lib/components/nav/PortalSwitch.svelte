<!--
  PortalSwitch - the two ways in, side by side in every top bar: the home page,
  WoCo (attendees) and organiser mode. Both are always there, signed in or not,
  so anyone can step between the portals; the one you are in is lit.

  Each opens its portal first and the portal asks for a sign-in where it needs
  one, so the login sheet always knows which kind of sign-in it is (an
  organiser's is passkey only).
-->
<script lang="ts">
  import { navigate } from "../../router/router.svelte.js";
  import {
    ATTENDEE_PORTAL_LABEL,
    ATTENDEE_PORTAL_PATH,
    ORGANISER_PORTAL_LABEL,
    ORGANISER_PORTAL_PATH,
  } from "./portal-labels.js";

  interface Props {
    /** The portal on screen, if any - the home page has none. */
    current?: "organiser" | "attendee";
  }
  let { current }: Props = $props();
</script>

<nav class="portal-switch" aria-label="Portals">
  <button
    class="seg"
    class:active={current === "organiser"}
    aria-current={current === "organiser" ? "page" : undefined}
    onclick={() => navigate(ORGANISER_PORTAL_PATH)}
  >
    {ORGANISER_PORTAL_LABEL}
  </button>
  <button
    class="seg"
    class:active={current === "attendee"}
    aria-current={current === "attendee" ? "page" : undefined}
    onclick={() => navigate(ATTENDEE_PORTAL_PATH)}
  >
    {ATTENDEE_PORTAL_LABEL}
  </button>
</nav>

<style>
  .portal-switch {
    display: inline-flex;
    flex-shrink: 0;
    padding: 2px;
    gap: 2px;
    border: 1px solid var(--border-hover);
    border-radius: var(--radius-sm);
    background: var(--bg);
  }

  .seg {
    padding: 0.375rem 0.75rem;
    font-family: var(--font-body);
    font-size: 0.8125rem;
    font-weight: 600;
    line-height: 1.2;
    white-space: nowrap;
    color: var(--text-secondary);
    background: transparent;
    border: none;
    border-radius: calc(var(--radius-sm) - 2px);
    cursor: pointer;
    transition: color var(--transition), background var(--transition);
  }
  .seg:hover { color: var(--accent-text); background: var(--accent-subtle); }
  .seg:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }

  .seg.active,
  .seg.active:hover {
    color: var(--accent-ink);
    background: var(--accent);
  }

  @media (max-width: 400px) {
    .seg { padding: 0.375rem 0.5625rem; font-size: 0.75rem; }
  }
</style>
