// The seat map renderer: framework-free SVG, shared by the builder, the buyer's map
// (app, organisers' websites, the embed), thumbnails and the dashboard. docs/SEATING.md.
export { APP_PALETTE, paletteFromCss, bandStyle, type SeatmapPalette, type BandStyle, type BandFillKind } from "./palette.js";
export {
  el, drawDefs, drawItem, drawThumb, drawOrder, handlesFor, swatchSvg, layoutSeatAt,
  type BuyerView, type DrawMode, type DrawOptions, type HandleKind,
} from "./draw.js";
export { ADD_ICONS, MARK_ICONS } from "./icons.js";
