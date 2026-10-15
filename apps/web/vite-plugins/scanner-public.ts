import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

/**
 * The only files the door scanner takes from `public/`.
 *
 * `public/` also holds test pages (passkey-check.html, passkey-window-test.html,
 * its -sw.js, popup-test.html) that call `navigator.credentials` with the RP ID
 * `woco.eth.limo`. The scanner is served at `scan.woco.eth.limo`, under that RP
 * ID, where such a page could ask for a user's passkey - so the scanner build
 * copies this list (`publicDir: false`) instead of the whole directory, and a
 * file added to `public/` never reaches it, or its service worker's precache,
 * by default.
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
