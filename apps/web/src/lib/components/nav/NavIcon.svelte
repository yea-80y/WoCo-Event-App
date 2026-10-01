<!--
  WoCo's own tab-bar icons. One drawing rule for the set: a 24 grid, 2px stroke,
  square ends and mitred corners, to match the app's sharp radii. The active tab
  fills one part of its icon in the accent, and each icon answers being chosen
  with one short movement; nothing moves on its own.
-->
<script lang="ts" module>
  export type NavIconName =
    | "home"
    | "events"
    | "invite"
    | "contacts"
    | "dashboard"
    | "build"
    | "audience"
    | "sites";
</script>

<script lang="ts">
  interface Props {
    name: NavIconName;
    active?: boolean;
    /** The key's menu is open: Build's plus turns to a close mark. */
    open?: boolean;
    /** Bumped on every press of a key, so Invite's scan line plays each time. */
    pulse?: number;
    size?: number;
  }
  let { name, active = false, open = false, pulse = 0, size = 24 }: Props = $props();
</script>

<svg
  class="ic"
  class:on={active}
  class:open
  viewBox="0 0 24 24"
  width={size}
  height={size}
  aria-hidden="true"
  focusable="false"
>
  {#if name === "home"}
    <path d="M3 11 12 3l9 8" />
    <path d="M5 9.2V21h14V9.2" />
    <rect x="9" y="13" width="6" height="8" />
    <rect class="glow" x="8" y="12" width="8" height="9" />
  {:else if name === "events"}
    <rect x="3" y="5" width="18" height="16" />
    <path d="M3 10h18M8 3v4M16 3v4" />
    <rect class="part stamp" x="13" y="13" width="4" height="4" />
  {:else if name === "invite"}
    <rect x="4" y="4" width="5" height="5" />
    <rect x="15" y="4" width="5" height="5" />
    <rect x="4" y="15" width="5" height="5" />
    <g class="solid">
      <rect x="6" y="6" width="1" height="1" />
      <rect x="17" y="6" width="1" height="1" />
      <rect x="6" y="17" width="1" height="1" />
      <rect x="14" y="14" width="2" height="2" />
      <rect x="18" y="14" width="3" height="2" />
      <rect x="16" y="17" width="2" height="2" />
      <rect x="14" y="19" width="2" height="2" />
      <rect x="19" y="19" width="2" height="2" />
    </g>
    {#key pulse}
      {#if pulse > 0}<rect class="scan" x="2" y="2" width="20" height="1.5" />{/if}
    {/key}
  {:else if name === "contacts"}
    <g class="step">
      <path d="M15.5 4.3a3.5 3.5 0 0 1 0 6.4" />
      <path d="M18 15.2a4 4 0 0 1 3 3.8v2" />
    </g>
    <circle class="part" cx="9" cy="7.5" r="3.5" />
    <path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" />
  {:else if name === "dashboard"}
    <rect class="pane part" x="3" y="3" width="7" height="9" />
    <rect class="pane p2" x="14" y="3" width="7" height="5" />
    <rect class="pane p3" x="14" y="12" width="7" height="9" />
    <rect class="pane p4" x="3" y="16" width="7" height="5" />
  {:else if name === "build"}
    <path class="plus" d="M12 5v14M5 12h14" />
  {:else if name === "audience"}
    <circle class="bob" cx="4.5" cy="10" r="2" />
    <path d="M1 21v-1.5a3.5 3.5 0 0 1 3.5-3.5" />
    <circle class="bob bob2" cx="19.5" cy="10" r="2" />
    <path d="M23 21v-1.5a3.5 3.5 0 0 0-3.5-3.5" />
    <circle class="part" cx="12" cy="8" r="3.5" />
    <path d="M6 21v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v1" />
  {:else if name === "sites"}
    <rect x="3" y="4" width="18" height="16" />
    <path d="M3 8h18" />
    <rect class="part" x="6" y="11" width="6" height="6" />
    <path class="draw" pathLength="1" d="M15 12h3" />
    <path class="draw" pathLength="1" d="M15 16h3" />
  {/if}
</svg>

<style>
  .ic {
    display: block;
    overflow: visible;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: square;
    stroke-linejoin: miter;
  }
  .ic * { transform-box: fill-box; }
  .solid { fill: currentColor; stroke: none; }

  /* The one rule: the active tab fills one part of its icon in the accent. */
  .part { transition: fill 0.2s var(--ease-out), stroke 0.2s var(--ease-out); }
  .on .part { fill: var(--accent); stroke: var(--accent); }

  /* Home: the light comes on behind the door. */
  .glow {
    fill: var(--accent);
    stroke: none;
    transform-origin: bottom;
    transform: scaleY(0);
    transition: transform 0.32s var(--ease-out);
  }
  .on .glow { transform: scaleY(1); }

  /* Events: today's date is stamped on. */
  .on .stamp { transform-origin: center; animation: stamp 0.34s var(--ease-out); }
  @keyframes stamp {
    0% { transform: scale(1.9); opacity: 0; }
    60% { opacity: 1; }
    100% { transform: scale(1); }
  }

  /* Contacts: someone steps in beside you. */
  .on .step { animation: step 0.36s var(--ease-out); }
  @keyframes step { from { transform: translateX(4px); opacity: 0; } }

  /* Dashboard: the panels settle into place, one after another. */
  .on .pane { transform-origin: center; animation: settle 0.36s var(--ease-out) backwards; }
  .on .p2 { animation-delay: 0.04s; }
  .on .p3 { animation-delay: 0.08s; }
  .on .p4 { animation-delay: 0.12s; }
  @keyframes settle { from { transform: scale(0.6); opacity: 0; } }

  /* Audience: the crowd jumps. */
  .on .bob { animation: bob 0.42s var(--ease-out); }
  .on .bob2 { animation-delay: 0.08s; }
  @keyframes bob { 45% { transform: translateY(-3px); } }

  /* Sites: the page draws itself in. */
  .draw { stroke-dasharray: 1 1; stroke-dashoffset: 0; }
  .on .draw { animation: draw 0.4s var(--ease-out) 0.08s backwards; }
  @keyframes draw { from { stroke-dashoffset: 1; } }

  /* Invite: a scan line passes over the code. */
  .scan { fill: currentColor; stroke: none; opacity: 0; animation: scan 0.5s var(--ease-out); }
  @keyframes scan {
    0% { transform: translateY(0); opacity: 0; }
    15%, 85% { opacity: 0.85; }
    100% { transform: translateY(19px); opacity: 0; }
  }

  /* Build: the plus turns to a close mark while its menu is open. */
  .plus { transform-origin: center; transition: transform 0.22s var(--ease-out); }
  .open .plus { transform: rotate(45deg); }

  @media (prefers-reduced-motion: reduce) {
    .ic * { animation: none !important; transition: none !important; }
  }
</style>
