<!--
  Pixel sprite — CRT monitor with a glyph on the screen.
  16x16 grid. Used on Creator "Build a venue site" tile.
-->
<script lang="ts">
  interface Props {
    size?: number | string;
    color?: string;
    screenColor?: string;
  }
  let { size = 48, color = "currentColor", screenColor = "var(--accent)" }: Props = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 16 16"
  shape-rendering="crispEdges"
  aria-hidden="true"
>
  <g fill={color}>
    <!-- monitor outer frame -->
    <rect x="1" y="2" width="14" height="1" />
    <rect x="1" y="3" width="1" height="8" />
    <rect x="14" y="3" width="1" height="8" />
    <rect x="1" y="11" width="14" height="1" />
    <!-- stand neck -->
    <rect x="7" y="12" width="2" height="2" />
    <!-- base -->
    <rect x="4" y="14" width="8" height="1" />
  </g>
  <!-- screen "phosphor" glow -->
  <g fill={screenColor}>
    <rect x="3" y="4" width="10" height="6" />
  </g>
  <!-- glyph on screen — pixel block + cursor caret -->
  <g fill={color}>
    <rect x="5" y="6" width="2" height="2" />
    <rect x="8" y="6" width="1" height="2" />
    <rect x="11" y="7" width="1" height="1" />
  </g>
</svg>
