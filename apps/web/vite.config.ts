import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  base: './',
  plugins: [svelte()],
  server: {
    proxy: {
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
