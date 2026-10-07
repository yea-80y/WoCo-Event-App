/**
 * The ticket image the email attaches: the shared portrait layout
 * (`@woco/shared/ticket/card`, the same steps the browser draws for the ticket
 * page's Save and the in-app download) as SVG, rasterised by resvg.
 *
 * Buyers never see the ticket's edition (its sequence tells them how many have
 * sold): a group order numbers its own tickets ("Ticket 2 of 4"), a single one
 * says "Your ticket". The edition stays inside the QR payload for the door.
 *
 * resvg reads system fonts (DejaVu/Liberation are on every common server
 * image); the browser draws with the app's fonts. Layout, colours and text are
 * identical either way.
 */

import { Resvg } from "@resvg/resvg-js";
import type { SitePalette } from "@woco/shared";
import {
  TICKET_CARD_HEIGHT,
  TICKET_CARD_WIDTH,
  ticketCardColours,
  ticketCardOps,
} from "@woco/shared/ticket/card";
import { ticketCardSvg } from "./card-svg.js";
import type { EventPhoto } from "./event-photo.js";

export interface TicketCardData {
  eventTitle: string;
  /** ISO start. */
  eventDate?: string;
  /** ISO end. */
  eventEndDate?: string;
  /** One line, as the organiser typed it. */
  eventLocation?: string;
  /** The ticket type. */
  seriesName?: string;
  /** Position in this order; null for a single ticket. */
  position: { n: number; of: number } | null;
  /** `woco://t/{eventId}/{seriesId}/{edition}/{sig}` - the door reads this. */
  qrContent: string;
  /** Organiser site palette; WoCo's own look when absent. */
  palette?: SitePalette;
  /** The event photo, when it could be read. */
  photo?: EventPhoto | null;
}

/** Sharp on a phone, small enough to attach a group order's worth. */
export const TICKET_PNG_WIDTH = 720;

export async function renderTicketCardPng(data: TicketCardData): Promise<Buffer> {
  const colours = ticketCardColours(data.palette);
  const ops = ticketCardOps({
    title: data.eventTitle,
    startIso: data.eventDate,
    endIso: data.eventEndDate,
    location: data.eventLocation,
    series: data.seriesName,
    position: data.position ?? undefined,
    hasPhoto: !!data.photo,
    colours,
  });
  const svg = ticketCardSvg(ops, {
    width: TICKET_CARD_WIDTH,
    height: TICKET_CARD_HEIGHT,
    qrContent: data.qrContent,
    photo: data.photo ?? null,
  });
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: TICKET_PNG_WIDTH },
    background: colours.bg,
    font: {
      loadSystemFonts: true,
      defaultFontFamily: "DejaVu Sans",
      sansSerifFamily: "DejaVu Sans",
      monospaceFamily: "DejaVu Sans Mono",
    },
  });
  return Buffer.from(resvg.render().asPng());
}
