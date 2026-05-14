<!--
  Pixel sprite — torn ticket stub. 16x16 grid, rendered at any size.
  Used on splitter Organiser CTA + Creator "Create event" tile.
-->
<script lang="ts">
  interface Props {
    size?: number | string;
    color?: string;
  }
  let { size = 48, color = "currentColor" }: Props = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill={color}
  shape-rendering="crispEdges"
  aria-hidden="true"
>
  <!-- top edge -->
  <rect x="2" y="3" width="11" height="1" />
  <!-- left + right edges -->
  <rect x="2" y="4" width="1" height="9" />
  <rect x="12" y="4" width="1" height="2" />
  <rect x="12" y="7" width="1" height="1" />
  <rect x="12" y="9" width="1" height="1" />
  <rect x="12" y="11" width="1" height="2" />
  <!-- bottom edge -->
  <rect x="2" y="13" width="11" height="1" />
  <!-- inner star / glyph -->
  <rect x="6" y="6" width="1" height="1" />
  <rect x="7" y="5" width="1" height="3" />
  <rect x="6" y="7" width="3" height="1" />
  <rect x="8" y="6" width="1" height="1" />
  <!-- dashed perforation hint (stub edge) -->
  <rect x="9" y="8" width="1" height="1" />
  <rect x="9" y="10" width="1" height="1" />
  <rect x="9" y="12" width="1" height="1" />
</svg>
