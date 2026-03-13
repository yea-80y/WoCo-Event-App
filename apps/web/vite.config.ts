import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  base: './',
  plugins: [
    nodePolyfills({ globals: { Buffer: true, process: true } }),
    svelte(),
  ],
  server: {
    proxy: {
      // Routes that run on local dev server (not yet deployed to production)
      '/api/site': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/api/profile': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/api': {
        target: 'https://events-api.woco-net.com',
        changeOrigin: true,
        // Disable response buffering so streamed NDJSON arrives chunk-by-chunk
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            // Ensure no compression/buffering on streamed responses
            proxyRes.headers['cache-control'] = 'no-cache';
          });
        },
      },
    },
  },
})
