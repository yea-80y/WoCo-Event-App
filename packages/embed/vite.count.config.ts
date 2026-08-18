/**
 * The lap-count bundle, and the self-contained OBS overlay built from it.
 *
 * A SECOND CONFIG RATHER THAN A SECOND ENTRY: vite's library mode emits one
 * entry per IIFE build, and an IIFE is the delivery shape both consumers need
 * (a custom element on a page that runs no bundler). `emptyOutDir` is off so
 * this build does not remove `woco-embed.js`, which the first build produced.
 *
 * THE OVERLAY SHIPS AS ONE FILE, with the bundle inlined. OBS browser sources
 * load a local file, and a local file that pulls its script over the network
 * would put our web tier and a 4-hour CDN cache on the critical path of a live
 * broadcast — for the shell of a page whose only real dependency is the count
 * request itself. One file also means a streamer can be handed the overlay and
 * keep it, which is what "the artifact has to stand alone" means in practice.
 */

import { defineConfig, type Plugin } from "vite";
import { RITA_SUBJECT_HASH } from "./src/count/pilot.js";

const API_URL = "https://events-api.woco-net.com";

/**
 * OBS's Local File mode has NO query string, so the overlay cannot be
 * configured by URL the way a hosted page would be. The configuration is
 * therefore markup at the top of the file, fenced and commented, which a
 * streamer can actually find and edit — and which survives being copied to
 * another machine, unlike a URL somebody has to be told.
 */
function overlayHtml(script: string): string {
  // A minified bundle can contain the literal `</script` inside a string, which
  // would close the tag early and leave the rest of the bundle as page text.
  const safe = script.replace(/<\/script/gi, "<\\/script");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>WoCo lap count — stream overlay</title>
<style>
  /* OBS composites this over video and paints transparency behind it, so the
     page must never paint a background of its own. */
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
</style>
</head>
<body>

<!-- ===========================================================
     OBS SETUP
       Sources  →  +  →  Browser
       tick "Local file", and choose this file
       Width 600, Height 260 is a good starting size
       Leave "Shutdown source when not visible" ticked — the count
       picks straight back up when the scene returns.

     EDIT BELOW TO POINT AT A DIFFERENT CHALLENGE OR COASTER.
       challenge  the event's own name. Free text — it is your event
                  to name. It appears ALONGSIDE the coaster, never
                  instead of it.
       subject    which coaster is being counted. A coaster WoCo does
                  not know renders as "Unknown coaster (0x…)" rather
                  than as a name, which is deliberate.

     WHAT THE NUMBER MEANS. It is every lap published for this coaster
     by everyone, not one rider's — so it shows the rider count as soon
     as more than one person has logged laps. A "+" means some logbooks
     could not be read on that pass, so the real total is at least the
     number shown. Nothing appears at all until the counter answers:
     a zero would be a claim, and a dead counter is not a zero.
     =========================================================== -->

<woco-lap-count
  variant="overlay"
  challenge="RITA 100"
  subject="${RITA_SUBJECT_HASH}"
  api-url="${API_URL}"
></woco-lap-count>

<!-- =========================================================== -->

<script>${safe}</script>
</body>
</html>
`;
}

function inlineOverlay(): Plugin {
  return {
    name: "woco-inline-overlay",
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find(
        (c): c is typeof c & { type: "chunk"; code: string } => c.type === "chunk" && c.isEntry,
      );
      if (!entry) {
        this.error("lap-count bundle produced no entry chunk — overlay.html would ship empty");
        return;
      }
      this.emitFile({ type: "asset", fileName: "overlay.html", source: overlayHtml(entry.code) });
    },
  };
}

export default defineConfig({
  build: {
    lib: {
      entry: "src/count/index.ts",
      name: "WocoLapCount",
      formats: ["iife"],
      fileName: () => "woco-count.js",
    },
    outDir: "dist",
    emptyOutDir: false,
    minify: true,
    sourcemap: false,
  },
  plugins: [inlineOverlay()],
});
