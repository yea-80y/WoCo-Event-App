<!--
  Pixel sprite — open door (the "I'm here for a show" entry).
  16x16 grid. The door swings; a small spark hints the show is on.
-->
<script lang="ts">
  interface Props {
    size?: number | string;
    color?: string;
    sparkColor?: string;
  }
  let { size = 48, color = "currentColor", sparkColor = "var(--accent)" }: Props = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 16 16"
  shape-rendering="crispEdges"
  aria-hidden="true"
>
  <g fill={color}>
    <!-- door frame -->
    <rect x="3" y="2" width="8" height="1" />
    <rect x="3" y="3" width="1" height="11" />
    <rect x="10" y="3" width="1" height="11" />
    <rect x="3" y="13" width="8" height="1" />
    <!-- door, swung open inward -->
    <rect x="5" y="3" width="5" height="1" />
    <rect x="5" y="3" width="1" height="11" />
    <rect x="5" y="13" width="5" height="1" />
    <!-- handle -->
    <rect x="7" y="8" width="1" height="1" />
  </g>
  <!-- spark coming through -->
  <g fill={sparkColor}>
    <rect x="12" y="6" width="1" height="1" />
    <rect x="13" y="7" width="1" height="1" />
    <rect x="12" y="8" width="1" height="1" />
    <rect x="14" y="8" width="1" height="1" />
    <rect x="13" y="9" width="1" height="1" />
  </g>
</svg>
