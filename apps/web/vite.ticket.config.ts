/**
 * The static ticket page (dist/ticket.html) - built after the main app, into the
 * same dist/, so the normal frontend upload carries it with no extra step.
 *
 * A separate config because library mode emits one IIFE per build, and the page
 * must be ONE file with its script inlined (see vite-plugins/ticket-page.ts for
 * why). `emptyOutDir` is off so the main app build survives.
 */
import { defineConfig } from "vite";
import { ticketPagePlugin } from "./vite-plugins/ticket-page";

export default defineConfig({
  build: {
    lib: {
      entry: "src/ticket/ticket-page.ts",
      name: "WocoTicketPage",
      formats: ["iife"],
      fileName: () => "ticket-page.js",
    },
    outDir: "dist",
    emptyOutDir: false,
    minify: true,
    sourcemap: false,
    copyPublicDir: false,
  },
  plugins: [ticketPagePlugin()],
});
