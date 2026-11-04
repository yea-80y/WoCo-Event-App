/**
 * Coalesces the Seats tab's changes into one save per burst (S6): taps show at once,
 * and the seat state is written about a second and a half after the last one - a large
 * plan's state is up to ~100 chunks, so a save per tap would spend the relay's budget
 * for nothing. One save at a time; what arrives meanwhile goes in the next. A failed
 * save keeps its changes and says so; "Try again" sends them.
 */

import { mergeDeltas } from "./organiser-seats.js";
import type { SeatStateDelta } from "./seat-state.js";
import type { SeatState } from "@woco/shared/seating/state";

export type SaverStatus =
  | { phase: "idle" }
  | { phase: "waiting" }
  | { phase: "saving" }
  | { phase: "saved"; settled: boolean }
  | { phase: "failed"; message: string };

export interface SaverDeps {
  save(delta: SeatStateDelta): Promise<{ state: SeatState; settled: boolean }>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export const SAVE_AFTER_MS = 1_500;

const empty = (d: SeatStateDelta) => !d.hold?.size && !d.release?.length && !d.confirm?.size;

export class SeatStateSaver {
  /** Not yet sent. */
  pending: SeatStateDelta = {};
  /** Sent, not yet answered. */
  inFlight: SeatStateDelta = {};
  status: SaverStatus = { phase: "idle" };
  private timer: unknown = null;

  constructor(
    private readonly deps: SaverDeps,
    private readonly onChange: (s: SeatStateSaver) => void,
    private readonly onSaved: (state: SeatState) => void,
  ) {}

  /** Everything not yet saved, for drawing. */
  unsaved(): SeatStateDelta {
    return mergeDeltas(this.inFlight, this.pending);
  }

  add(d: SeatStateDelta): void {
    if (empty(d)) return;
    this.pending = mergeDeltas(this.pending, d);
    if (this.status.phase !== "saving") this.schedule();
    this.onChange(this);
  }

  /** Send now (the "Try again" button, or leaving the tab). */
  flush(): Promise<void> {
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = null;
    return this.run();
  }

  private schedule(): void {
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.status = { phase: "waiting" };
    this.timer = this.deps.setTimeout(() => {
      this.timer = null;
      void this.run();
    }, SAVE_AFTER_MS);
  }

  private async run(): Promise<void> {
    if (this.status.phase === "saving" || empty(this.pending)) return;
    this.inFlight = this.pending;
    this.pending = {};
    this.status = { phase: "saving" };
    this.onChange(this);
    try {
      const r = await this.deps.save(this.inFlight);
      this.inFlight = {};
      this.onSaved(r.state);
      if (!empty(this.pending)) {
        this.schedule();
      } else {
        this.status = { phase: "saved", settled: r.settled };
      }
    } catch (err) {
      // Kept, merged under anything added since: nothing the organiser did is dropped.
      this.pending = mergeDeltas(this.inFlight, this.pending);
      this.inFlight = {};
      this.status = { phase: "failed", message: err instanceof Error && err.message ? err.message : "Couldn't save your changes." };
    }
    this.onChange(this);
  }
}
