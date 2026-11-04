/**
 * The seat map frame bundle, `dist/woco-seatmap.js` (docs/SEATING.md; S3 consult Q3).
 * Served by the API beside woco-embed.js and loaded only by its own page,
 * /embed/seatmap/:eventId/:seriesId, which the ticket widget opens full screen for a
 * seated ticket type. The widget itself stays framework-free and small; this bundle
 * carries Svelte and the shared SeatPicker, so the app, organisers' websites and the
 * embed run one seat map. Component CSS is injected by the bundle (one file to serve).
 */
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  // A plan above 20,000 seats parses in a Worker (@woco/seatmap/parse): its chunk is
  // emitted to dist/assets and served by the API at /embed/assets/<hashed name>.
  base: "/embed/",
  plugins: [svelte({ compilerOptions: { css: "injected" } })],
  build: {
    lib: {
      entry: "src/seatframe/main.ts",
      name: "WocoSeatmap",
      formats: ["iife"],
      fileName: () => "woco-seatmap.js",
    },
    outDir: "dist",
    emptyOutDir: false,
    minify: true,
    sourcemap: false,
  },
});
