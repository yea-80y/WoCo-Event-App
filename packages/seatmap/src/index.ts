// The seat map renderer: framework-free SVG, shared by the builder, the buyer's map
// (app, organisers' websites, the embed), thumbnails and the dashboard. docs/SEATING.md.
export { APP_PALETTE, paletteFromCss, bandStyle, type SeatmapPalette, type BandStyle, type BandFillKind } from "./palette.js";
export {
  el, drawDefs, drawItem, drawThumb, drawOverviewThumb, drawOrder, handlesFor, swatchSvg, layoutSeatAt,
  type BuyerView, type DrawMode, type DrawOptions, type HandleKind,
} from "./draw.js";
export { ADD_ICONS, MARK_ICONS } from "./icons.js";
export {
  buyerPlan, seatAt, togglePick, prunePicks, bestFor, loneSeat,
  formatMinor, seatText, seatNumber, bandName, spokenLabel, sectionSummaries, neighbour,
  type BuyerPlan, type Section, type PickRefusal, type SectionSummary, type Direction,
} from "./buyer.js";
export { createPicker, pickerCss, type Picker, type PickerOptions, type PickerState } from "./picker.js";
export {
  loadSeatMap, type SeatMapSeries, type SeatMapDeps, type SeatMapProblem, type SeatMapSnapshot, type LiveSeatMap,
} from "./load.js";
export { parsePlan, PARSE_IN_PAGE_MAX_SEATS } from "./parse.js";
export type { Level, View, Screen } from "./view.js";
