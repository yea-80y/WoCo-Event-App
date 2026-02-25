import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

/**
 * Vite config for generating the site-builder output.
 * Entry: site.html → src/site-main.ts → SiteApp.svelte
 * Output: dist-site/ (uploaded to Swarm by the organiser)
 *
 * Env vars read from apps/web/.env.site (not .env):
 *   VITE_API_URL       — organiser's self-hosted backend URL
 *   VITE_GATEWAY_URL   — Swarm gateway for image/asset serving
 *   VITE_EVENT_ID      — the specific event to display
 *   VITE_PARA_API_KEY  — Para wallet API key
 */
export default defineConfig({
  base: './',
  envDir: '.',
  envPrefix: 'VITE_',
  plugins: [
    nodePolyfills({ globals: { Buffer: true, process: true } }),
    svelte(),
  ],
  build: {
    outDir: 'dist-site',
    rollupOptions: {
      input: 'site.html',
    },
  },
})
