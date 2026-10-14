// The app's entry. It decides WHICH build runs - this one or a newer one
// (lib/boot/build-check.ts) - and only then loads the app. Kept small: the app's
// own modules are preloaded by the HTML (vite-plugins/preload-app.ts) but never
// evaluated until this says so, so a page that hands over runs no old app code.
import { checkBuild, pageSources, parseBuildFeed } from './lib/boot/build-check'
import { swapToBuild } from './lib/boot/build-swap'

const RELOAD_GUARD = 'woco:boot:reloaded-for'

async function start(): Promise<unknown> {
  // A newer build's entry, started by an older page that already did the check.
  if ((window as { __wocoBoot?: unknown }).__wocoBoot) return import('./main')

  const feed = parseBuildFeed(document.querySelector('meta[name="woco-feed"]')?.getAttribute('content'))
  if (!feed) return import('./main') // dev server, or a build not served from the feed

  try {
    const where = pageSources(window.location)
    let storage: Storage | null = null
    try {
      storage = window.localStorage
    } catch {
      // storage blocked: check anyway, remember nothing
    }
    const decision = await checkBuild({
      feed,
      sources: where.sources,
      storage,
      graceMs: where.ownNode ? 1500 : 700,
      holdAfterHitMs: 2000,
      probeTimeoutMs: where.ownNode ? 4000 : 3000,
    })
    if (decision.kind === 'newer') {
      const result = await swapToBuild(decision.point, feed, where.pageBases)
      if (result === 'swapped') return
      if (result === 'reload') {
        let tried = false
        try {
          tried = sessionStorage.getItem(RELOAD_GUARD) === String(decision.point.index)
          sessionStorage.setItem(RELOAD_GUARD, String(decision.point.index))
        } catch {
          tried = true // no way to stop a loop, so never reload
        }
        if (!tried) {
          window.location.reload()
          return
        }
      }
    }
  } catch (e) {
    console.warn('[boot] build check failed, starting this build', e)
  }
  return import('./main')
}

void start()
