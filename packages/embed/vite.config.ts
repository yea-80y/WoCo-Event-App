import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      name: "WocoEmbed",
      formats: ["iife"],
      fileName: () => "woco-embed.js",
    },
    outDir: "dist",
    minify: true,
    sourcemap: false,
  },
});
