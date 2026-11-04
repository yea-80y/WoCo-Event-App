/**
 * The first two content gateways the static ticket page may load an event image from.
 * Index into this list travels in the ticket link as `g`, so the link names no host.
 *
 * Its own module with no imports: the ticket page's build config (vite-plugins/ticket-page.ts)
 * reads it to write the page's CSP, and Node loads that config without a bundler, so it
 * cannot follow `link.ts`'s own imports.
 */
export const TICKET_IMAGE_GATEWAYS = [
  "https://gateway.woco-net.com",
  "https://gateway.etherna.io",
] as const;
