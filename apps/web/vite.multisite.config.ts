import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

/**
 * Vite config for the multi-page site renderer.
 * Entry: multi-site.html → src/multi-site-main.ts → MultiSiteApp.svelte
 * Output: dist-multisite/ (uploaded to Swarm by the deploy step)
 *
 * In dev the app falls back to Black-Prince/site.json when window.SITE_CONFIG
 * is not set. No env file required to get a working preview.
 *
 * Env vars (optional — override defaults):
 *   VITE_API_URL       — backend API base URL (default: http://localhost:3001)
 *   VITE_GATEWAY_URL   — Swarm gateway for image/asset serving
 */
export default defineConfig({
  base: './',
  envDir: '.',
  envPrefix: 'VITE_',
  plugins: [
    nodePolyfills({ globals: { Buffer: true, process: true } }),
    svelte(),
  ],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist-multisite',
    rollupOptions: {
      input: 'multi-site.html',
    },
  },
})
