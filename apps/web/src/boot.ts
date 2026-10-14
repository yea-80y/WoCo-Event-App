// The app's entry. It decides WHICH build runs - this one or a newer one
// (lib/boot/build-check.ts) - and only then loads the app. Kept small: the app's
// own modules are preloaded by the HTML (vite-plugins/preload-app.ts) but never
// evaluated until this says so, so a page that hands over runs no old app code.
import { checkBuild, pageSources, parseBuildFeed } from './lib/boot/build-check'
import { swapToBuild, type BootWindow } from './lib/boot/build-swap'

const RELOAD_GUARD = 'woco:boot:reloaded-for'

async function start(): Promise<unknown> {
  // A newer build's entry, started by an older page that already did the check. The
  // older page waits on `ready`, so a failed app load is its to recover from.
  const handover = (window as BootWindow).__wocoBoot
  if (handover) return (handover.ready = import('./main'))

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
      const target = String(decision.point.index)
      let reloaded = true // unknown = assume yes: without storage a reload could loop
      try {
        reloaded = sessionStorage.getItem(RELOAD_GUARD) === target
      } catch {
        // storage blocked
      }
      const result = await swapToBuild(decision.point, feed, where.pageBases, { patient: reloaded })
      if (result === 'swapped') return
      if (result === 'same') console.info(`[boot] build ${decision.point.index} is this code redeployed; starting it here`)
      if (result === 'reload' && !reloaded) {
        try {
          sessionStorage.setItem(RELOAD_GUARD, target)
          window.location.reload()
          return
        } catch {
          // cannot record the reload, so do not risk a loop
        }
      }
    }
  } catch (e) {
    console.warn('[boot] build check failed, starting this build', e)
  }
  return import('./main')
}

void start()
