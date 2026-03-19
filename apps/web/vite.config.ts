import { defineConfig, loadEnv } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  // Dev: proxy to local server. Production API is set via VITE_API_URL at build time.
  const apiTarget = env.VITE_DEV_API_URL || 'http://localhost:3001'

  return {
    base: './',
    plugins: [
      nodePolyfills({ globals: { Buffer: true, process: true } }),
      svelte(),
    ],
    server: {
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          // Disable response buffering so streamed NDJSON arrives chunk-by-chunk
          configure: (proxy) => {
            proxy.on('proxyRes', (proxyRes) => {
              proxyRes.headers['cache-control'] = 'no-cache';
            });
          },
        },
      },
    },
  }
})
