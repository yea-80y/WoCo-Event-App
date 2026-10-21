import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

/**
 * The only files the door scanner takes from `public/`.
 *
 * `public/` is the app's, and has held pages that call `navigator.credentials`
 * (the passkey test pages of 2026-10, gone since the passkey window). The scanner
 * is served at `scan.woco.eth.limo`, its own origin, so the scanner build copies
 * this list (`publicDir: false`) instead of the whole directory: a file added to
 * `public/` never reaches it, or its service worker's precache, by default.
 */
export const SCANNER_PUBLIC_FILES = ['logo.png'] as const

export function scannerPublicFiles(publicDir: string): Plugin {
  return {
    name: 'scanner-public-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = (req.url ?? '').split('?')[0].replace(/^\//, '')
        if (!(SCANNER_PUBLIC_FILES as readonly string[]).includes(name)) return next()
        res.end(readFileSync(join(publicDir, name)))
      })
    },
    generateBundle() {
      for (const fileName of SCANNER_PUBLIC_FILES) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(join(publicDir, fileName)) })
      }
    },
  }
}
