/**
 * The organiser's side of a seated ticket type's seat state (`woco.seatstate.v1`,
 * docs/SEATING.md Decisions 3 + 5): read it, and carry it to a new feed signer when the
 * account's keys move (#186). Written by the dashboard only (`writeSeatState`, S6).
 *
 * Thorough reads only: "absent" here decides what is written, and a state that cannot
 * be read stops the caller rather than being taken as never written.
 */

import type { EventFeed } from "@woco/shared";
import type { SeatState } from "@woco/shared/seating/state";
import type { ContentFeedResult } from "../../swarm/content-feed.js";
import type { FeedRoute } from "../../swarm/gateways.js";

export interface SeatStateIO {
  read(signer: string, topic: string, route: FeedRoute): Promise<ContentFeedResult<unknown>>;
  write(args: { signerPrivKey: string; topic: string; data: unknown; route: FeedRoute }): Promise<number>;
  route(feed: Pick<EventFeed, "gatewayUrl">): FeedRoute;
}

export class SeatStateUnreadableError extends Error {
  constructor(message = "Couldn't read your seat holds just now - nothing was changed. Try again.") {
    super(message);
    this.name = "SeatStateUnreadableError";
  }
}

/** The event's seated ticket types (a `seating` block names the plan's band prices). */
export function seatedSeriesIds(feed: Pick<EventFeed, "series">): string[] {
  return feed.series.filter((s) => s.seating !== undefined).map((s) => s.seriesId);
}

/**
 * The state under `signer`, as stored: null when never written. Throws when it cannot
 * be read conclusively (an older version could be the one found).
 */
export async function readStoredSeatState(
  io: SeatStateIO,
  signer: string,
  feed: Pick<EventFeed, "eventId" | "gatewayUrl">,
  seriesId: string,
): Promise<{ value: unknown; version: number } | null> {
  const { seatStateTopic } = await import("@woco/shared/seating/topics");
  const res = await io.read(signer, seatStateTopic(feed.eventId, seriesId), io.route(feed));
  if (res.status === "unavailable" || (res.status === "found" && !res.scanClean)) throw new SeatStateUnreadableError();
  return res.status === "found" ? { value: res.value, version: res.version } : null;
}

/** A stored state that is this ticket type's, well formed. */
export async function ownSeatState(value: unknown, eventId: string, seriesId: string): Promise<SeatState | null> {
  const { validateSeatState } = await import("@woco/shared/seating/state");
  return validateSeatState(value) && value.eventId === eventId && value.seriesId === seriesId ? value : null;
}

/**
 * Key rotation (#186), before the flip: every seated ticket type's state, as stored and
 * at the same `seq`, under the new signer. The server reads the new signer once the flip
 * lands; a state left behind would read as never written there - the plan's own holds
 * back, and every confirmation gone. Copied verbatim, malformed or not: what the server
 * made of it under the old signer is what it makes of it under the new one. An
 * unreadable state stops the removal before anything changes; this runs inside the
 * copying phase, which a resumed removal runs again until the flip.
 */
export async function copySeatStates(
  io: SeatStateIO,
  feed: Pick<EventFeed, "eventId" | "gatewayUrl" | "series">,
  oldSigner: string,
  newSignerPrivKey: string,
): Promise<number> {
  const { seatStateTopic } = await import("@woco/shared/seating/topics");
  let copied = 0;
  for (const seriesId of seatedSeriesIds(feed)) {
    const stored = await readStoredSeatState(io, oldSigner, feed, seriesId);
    if (!stored) continue;
    await io.write({ signerPrivKey: newSignerPrivKey, topic: seatStateTopic(feed.eventId, seriesId), data: stored.value, route: io.route(feed) });
    copied++;
  }
  return copied;
}

/** The live wiring: the app's content-feed reader and writer. */
export async function liveSeatStateIO(): Promise<SeatStateIO> {
  const [{ readContentFeedResult, writeContentFeed }, { feedRouteFor }] = await Promise.all([
    import("../../swarm/content-feed.js"),
    import("../../swarm/gateways.js"),
  ]);
  return {
    read: (signer, topic, route) => readContentFeedResult<unknown>(signer, topic, { route, thorough: true, skipLegacy: true }),
    write: (args) => writeContentFeed(args),
    route: (feed) => feedRouteFor(feed.gatewayUrl),
  };
}
