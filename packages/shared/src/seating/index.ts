// Allocated seating: `import { ... } from "@woco/shared/seating/index"`. Not re-exported
// from the package root, so its constructors (`table`, `shape`, ...) never shadow other names.
export {
  SEAT_LAYOUT_FORMAT, MAX_SEAT_BANDS, MAX_PLAN_SEATS, MAX_PLAN_ITEMS, MAX_ROWS_PER_BLOCK, MAX_SEATS_PER_ROW,
  MAX_TABLE_SEATS, TABLE_SHAPES, SHAPE_KINDS, FOCUS_KINDS, isGap, hasSeats, seatLists, validateSeatLayout,
  type TableShape, type ShapeKind, type LayoutSeat, type SeatBand, type RowsItem, type TableItem, type ShapeItem,
  type LayoutItem, type SeatLayout,
} from "./layout.js";
export {
  SEAT_PLAN_FORMAT, seatRefs, canonicalSeats, seatLabel, formatSeatLabel, ticketSeatOf, seatPlanProblems, freezeSeatPlan,
  layoutOfPlan, validateSeatPlan, initialHeldSeats, canonicalSeatPlan, encodeSeatPlan, seatPlanDigest, parseSeatPlan,
  isSeatIndex, MAX_SEAT_PLAN_BYTES,
  type PlanSeat, type SeatPlan, type SeatRef, type SeatLabel, type SeatPlanProblem,
} from "./plan.js";
export { seatPlanEditionTemplate, seatPlanTemplateOf, type SeatPlanTemplate } from "./template.js";
export {
  isTicketSeat, ticketSeatText, ticketSeatPlace, ticketSeatFields, ticketSeatNote, type TicketSeat, type TicketSeatField,
} from "./ticket-seat.js";
export { seriesSeatingRefusal, bandPricesMinor, priceMinor } from "./series.js";
export {
  SEAT_STATE_FORMAT, SEAT_HOLD_KINDS, PLAN_HOLD_KIND, heldBytes, encodeHeld, decodeHeld, validateSeatState, buildSeatState,
  seatStateView, organiserAllowsSale, seatStateWriteSignal, seatStateDigest,
  type SeatState, type SeatStateView, type SeatHold, type SeatHoldKind,
} from "./state.js";
export {
  SEAT_PITCH, SEAT_SIZE, roundTableRadius, longTableLength, headTableLength, itemGeometry, toWorld, toLocal,
  itemWorldBox, unionBox, seatWorldPoints, planFocus, itemSeatCount,
  type Box, type SeatPoint, type ItemLabel, type ItemGeometry,
} from "./geometry.js";
export { seatRuns, bestSeats, loneSeatLeft, LONE_SEAT_PENALTY, type SeatRun, type BestSeatsOptions } from "./best.js";
export {
  SEAT_FREE, SEAT_TAKEN, SEAT_NO_PRICE, SEAT_HELD, SEAT_UNCONFIRMED, SEAT_ON_HOLD, SEAT_UNKNOWN,
  saleState, seatStates, pickable, seatReason,
  type ChainSeats, type SaleState, type SeatCode, type SeatStateInput, type SeatStates,
} from "./availability.js";
export { SEAT_WORDS_PER_BATCH, SLOT_SEATS_PER_BATCH, seatBatch, slotSeatsBatch, seatWordCount, type SeatBatch, type SeatBatchRead, type SeatEventRead } from "./chain.js";
export {
  parseSeatedReserve, seatedReserveRefusal, seatedHoldFees, SEAT_HOLD_LOST_CODES, isSeatHoldLost,
  type SeatedHold, type SeatedReserveRequest, type SeatedReserveRefusal,
} from "./reserve.js";
export { seatLayoutLibraryTopic, seatLayoutTopic, seatStateTopic } from "./topics.js";
export {
  rowLetters, labelsAfter, normRot, labelWidth, idMaker, makeRow, rowsBlock, table, shape, LAYOUT_TEMPLATES,
  type LayoutTemplate,
} from "./templates.js";
