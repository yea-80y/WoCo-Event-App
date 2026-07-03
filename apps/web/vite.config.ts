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
      // `process` is excluded here so it is NOT polyfilled as the plugin's
      // __esModule-namespace shim (which breaks readable-stream's
      // `require('process').nextTick` — see resolve.alias below). The global
      // `process` is still injected; the module import resolves via the alias.
      nodePolyfills({ globals: { Buffer: true, process: true }, exclude: ['process'] }),
      svelte(),
    ],
    optimizeDeps: {
      // @web3auth/modal dynamically loads its sibling packages (no-modal, auth,
      // ws-embed) and i18n locale chunks at RUNTIME. If Vite only pre-bundles
      // `@web3auth/modal`, those siblings are discovered LATE → a SECOND optimize
      // pass re-hashes chunks → the already-loaded modal requests a stale `?v=` →
      // "504 Outdated Optimize Dep" at init(), which blocks BOTH login and restore.
      // Fix: pre-declare the whole web3auth family so the FIRST optimize pass is
      // complete and no second pass runs. Do NOT `exclude` them — that serves their
      // CJS sub-deps (bn.js via elliptic) as raw ESM → `import BN from 'bn.js'` has
      // no default export → sign-in breaks. Prod is unaffected (rollup ignores
      // optimizeDeps). Belt-and-braces: the auth store also treats an init() failure
      // as `unavailable` (keeps the session, retries the key) so a stray re-optimize
      // never logs the user out. After changing this list: delete
      // apps/web/node_modules/.vite AND clear the browser's cached dep modules.
      include: [
        '@web3auth/modal',
        '@web3auth/no-modal',
        '@web3auth/auth',
        '@web3auth/ws-embed',
      ],
    },
    resolve: {
      // vite-plugin-node-polyfills exposes `process` as an ES-module namespace
      // ({ default, process, __esModule }). The bundled readable-stream (via
      // Web3Auth's provider stack) does `require('process').nextTick(...)` and
      // gets the namespace, so `nextTick` is undefined in the prod rollup build
      // → setupWeb3 throws "t.nextTick is not a function" (readable-stream #539).
      // Aliasing bare `process` to the plain CJS `process/browser` shim returns
      // the process object directly, with nextTick on it. Dev (esbuild interop)
      // was unaffected. Exact-match regex so `process/browser` itself is untouched.
      alias: [{ find: /^process$/, replacement: 'process/browser' }],
    },
    build: {
      rollupOptions: {
        input: {
          main: 'index.html',
          multisite: 'multi-site.html',
        },
      },
    },
    server: {
      // Web3Auth's email login is a popup that posts the auth result back to the
      // opener; the browser default COOP can sever that handshake (the "would block
      // the window.closed call" warning) → access_denied. allow-popups keeps the
      // opener relationship while staying same-origin. Dev-only (server.headers).
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
      },
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
