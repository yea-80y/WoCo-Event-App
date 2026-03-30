import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  base: './',
  plugins: [
    nodePolyfills({ globals: { Buffer: true, process: true } }),
    svelte(),
  ],
  build: {
    outDir: 'dist',
  },
})
