// The seat map renderer: framework-free SVG, shared by the builder, the buyer's map
// (app, organisers' websites, the embed), thumbnails and the dashboard. docs/SEATING.md.
export { APP_PALETTE, paletteFromCss, bandStyle, type SeatmapPalette, type BandStyle, type BandFillKind } from "./palette.js";
export {
  el, drawDefs, drawItem, drawThumb, drawOrder, handlesFor, swatchSvg, layoutSeatAt,
  type BuyerView, type DrawMode, type DrawOptions, type HandleKind,
} from "./draw.js";
export { ADD_ICONS, MARK_ICONS } from "./icons.js";
export {
  SEAT_FREE, SEAT_TAKEN, SEAT_HELD, SEAT_ON_HOLD, SEAT_NO_PRICE,
  buyerPlan, seatAt, saleState, seatStates, pickable, togglePick, prunePicks, bestFor, loneSeat,
  formatMinor, seatText, seatNumber, bandName, spokenLabel, sectionSummaries, neighbour,
  type BuyerPlan, type Section, type ChainSeats, type SaleState, type SeatStates, type SeatStateInput,
  type PickRefusal, type SectionSummary, type Direction,
} from "./buyer.js";
export { createPicker, pickerCss, type Picker, type PickerOptions, type PickerState } from "./picker.js";
export type { Level, View, Screen } from "./view.js";
