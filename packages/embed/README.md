# @woco/embed

Two standalone IIFE bundles for organiser pages outside the platform:

- `dist/woco-embed.js` — `<woco-tickets>`: event card + ticket series with an
  inline buy flow. Email (+ any order-form fields, sealed client-side to the
  organiser's X25519 key) → guest Stripe checkout → ticket delivered by email.
  No wallet, no passkey, no account: the v2 rail mints at payment, so the
  widget's only job is to start a checkout session honestly.
- `dist/woco-count.js` + `dist/overlay.html` — `<woco-lap-count>` and the OBS
  overlay (see `vite.count.config.ts` for why the overlay is one file).

## How it reaches production (#188)

There is **no separate embed deploy**. The API server serves
`packages/embed/dist/woco-embed.js` at `GET /embed/woco-embed.js` straight off
its filesystem, so the embed ships with the normal server deploy — build it
first (`npm run build:embed` at the repo root) and the files ride along inside
the server image. The iframe variant (`GET /embed/frame/:eventId`) is a page
the server renders around the same bundle; its one inline script lives in
`apps/server/src/lib/http/security-headers.ts`, where its CSP hash is computed
from the constant so the two cannot drift.

Caching: the server sends `Cache-Control: max-age=3600` and the CDN edge holds
it longer, so a freshly deployed bundle can take **hours** to reach organiser
pages that embed it. The `?v=N` query on the snippet exists to cut past that:
**bump it in both emit sites whenever widget behaviour changes** —
`EmbedSetup.svelte` (the snippet handed to organisers) and the frame page in
`apps/server/src/index.ts`. Existing organiser pages keep their old `?v=` and
converge when caches expire; the bump makes new copies correct immediately.

## Testing

`npm test -w @woco/embed` — DOM-free rule modules (`src/checkout.ts`,
`src/count/display.ts`) carry the behaviour worth pinning; the custom elements
stay thin. `npm run check -w @woco/embed` typechecks (CI runs both).
