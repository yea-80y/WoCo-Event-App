<!--
  Pixel sprite — spray can with a cloud of paint. Pure graffiti voice.
  16x16 grid.
-->
<script lang="ts">
  interface Props {
    size?: number | string;
    color?: string;
    paintColor?: string;
  }
  let { size = 48, color = "currentColor", paintColor = "var(--accent)" }: Props = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 16 16"
  shape-rendering="crispEdges"
  aria-hidden="true"
>
  <g fill={color}>
    <!-- nozzle -->
    <rect x="5" y="3" width="2" height="1" />
    <!-- cap -->
    <rect x="4" y="4" width="4" height="2" />
    <!-- body -->
    <rect x="3" y="6" width="6" height="8" />
  </g>
  <!-- paint mist -->
  <g fill={paintColor}>
    <rect x="10" y="3" width="1" height="1" />
    <rect x="12" y="2" width="1" height="1" />
    <rect x="11" y="5" width="2" height="1" />
    <rect x="13" y="4" width="1" height="2" />
    <rect x="10" y="6" width="1" height="1" />
    <rect x="12" y="7" width="1" height="1" />
    <rect x="14" y="6" width="1" height="1" />
  </g>
</svg>
