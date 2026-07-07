import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { VitePWA } from 'vite-plugin-pwa'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Vite config for the door-scanner PWA.
 * Entry: scanner.html → src/scanner-main.ts → ScannerApp.svelte
 * Output: dist-scanner/ (own Swarm collection, e.g. scan.woco.eth.limo)
 *
 * The scanner is deliberately standalone: no auth stack, no external fonts,
 * no Swarm reads at runtime — provisioned entirely by a door-pass URL and the
 * /api/checkin endpoints, and fully functional offline once provisioned.
 */

/** Swarm collections serve index.html as the index document. */
function renameEntryToIndex(): Plugin {
  return {
    name: 'rename-scanner-entry',
    apply: 'build',
    closeBundle: async () => {
      await rename(join('dist-scanner', 'scanner.html'), join('dist-scanner', 'index.html')).catch(() => {})
    },
  }
}

export default defineConfig({
  base: './',
  envDir: '.',
  envPrefix: 'VITE_',
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['logo.png'],
      manifest: {
        name: 'WoCo Scanner',
        short_name: 'WoCo Scan',
        description: 'Door check-in scanner for WoCo events',
        theme_color: '#0B0B09',
        background_color: '#0B0B09',
        display: 'standalone',
        orientation: 'portrait',
        icons: [{ src: './logo.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg}'],
        // API calls are handled by our own sync layer, never the SW cache.
        navigateFallback: null,
      },
    }),
    renameEntryToIndex(),
  ],
  server: {
    port: 5175,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist-scanner',
    rollupOptions: {
      input: 'scanner.html',
    },
  },
})
