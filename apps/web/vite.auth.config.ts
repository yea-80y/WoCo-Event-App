/**
 * The passkey sign-in window (src/auth-window/) - one self-contained file for the
 * passkey host, pinned on L1 by the owner's Safe (vite-plugins/auth-window.ts).
 *
 *   npm run build:auth   production -> dist-auth/   (the only output ever uploaded)
 *   npm run dev:auth     dev window -> dist-auth-dev/, rebuilt on change and served on
 *                        http://localhost:5174 for the app's dev server on :5173
 *
 * The target comes from the Vite mode alone. Dev runs the real built file under its
 * CSP rather than a dev server, so what is tested locally is what ships.
 */
import { defineConfig } from "vite";
import { authWindowPlugin, authWindowTarget } from "./vite-plugins/auth-window";

export default defineConfig(({ mode }) => {
  const target = authWindowTarget(mode);
  return {
    define: {
      __AUTH_SELF_ORIGIN__: JSON.stringify(target.selfOrigin),
      __AUTH_RP_ID__: JSON.stringify(target.rpId),
      __AUTH_OPENERS__: JSON.stringify(target.openers),
    },
    publicDir: false,
    build: {
      lib: {
        entry: "src/auth-window/window.ts",
        name: "WocoAuthWindow",
        formats: ["iife"],
        fileName: () => "auth-window.js",
      },
      outDir: target.outDir,
      emptyOutDir: true,
      minify: true,
      sourcemap: false,
      copyPublicDir: false,
    },
    preview: { port: 5174, strictPort: true },
    plugins: [authWindowPlugin(target)],
  };
});
