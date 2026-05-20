## Security audit + creator portal reliability — 2026-05-17

Continuation point for a fresh chat. Read this top-to-bottom before resuming.

### What started this

Symptom: `/api/sites/mine` and `/api/events/mine` returned empty on first Studio load. Navigating away and back fixed it. The user asked for a security-engineer-grade audit, not just a UX patch.

### Root causes (both fixed and committed in 79754a2)

1. **Server-side empty-result poisoning.** `getCreatorSites` and `getCreatorEvents` memoized `[]` for 5s when `readFeedPage` returned `null` from a transient Swarm error. `listEvents` had the same bug on its `_dirCache`. Fix: only memoize populated results.

2. **Directory-wipe vulnerability (discovered while fixing #1).** `addToEventDirectory` and `upsertCreatorSite` were read-modify-write. If the read returned `[]` from a transient failure, the write clobbered the entire directory with just the new entry. Fix: new `readFeedPageStrict` returning `{ status: "ok" | "absent" | "error" }`; `readDirectoryStrict` / `readCreatorSitesStrict` wrap it and throw on error so the write is refused rather than wiping good state.

3. **Client-side SWR + don't-overwrite-with-empty.** `lib/api/creator-cache.ts` wraps every creator-portal fetch with `{ cached, refresh }`. Wired into CreatorHome, DashboardIndex, EventsTab. Cache writes skip empty arrays as defence in depth.

4. **User-scoped cache clear on logout.** `cacheClearByPrefix(USER_SCOPED_PREFIXES)` runs in `clearAllAuth` so shared-device sign-out doesn't leak prior user's events into the next user's UI.

### Committed + deployed: nonce replay blacklist (452b93c, 2026-05-17)

`apps/server/src/middleware/auth.ts` — in-memory Map keyed by `(sessionAddress, nonce)`, GC'd opportunistically when size ≥ 256, TTL = MAX_TIMESTAMP_SKEW_MS (5 min). Wired into both `requireAuth` and `tryVerifyAuth` AFTER sig verify. Deployed to 192.168.0.144, health check green.

### Remaining audit items (not started)

- **`readFeedPageWithRetry` caller audit** — same wipe vulnerability shape. Any read-modify-write using it could clobber on exhausted-retry null. Grep, classify each caller as read-only vs RMW, port RMW ones to `readFeedPageStrict`.
- **404-vs-5xx confirmation in Bee** — `readFeedPageStrict` treats only HTTP 404 as `absent`. Confirm Bee never returns 5xx for genuine feed absence; otherwise brand-new directories can't bootstrap.
- **POD identity ed25519 AAD audit** — confirm the AAD on the IndexedDB-encrypted ed25519 key derivation is correct. Separate task.
- **`docs/SECURITY_POSTURE.md`** — public-facing summary covering credential safety, HTTPS coverage, Stripe webhook risk (worst case = free tickets minted, NOT money theft — money flows inside Stripe network), light-client future.

### Stripe-only launch — money-theft analysis (from previous chat)

- Customer money is safe: charges/transfers happen inside Stripe's network, not via our server. We can't redirect funds.
- Webhook secret leak → attacker can forge `checkout.session.completed` → mint free tickets. Organiser loses inventory, not revenue.
- TLS break (laptop → Cloudflare Tunnel → server is HTTPS end-to-end; gateway-served frontend is HTTPS) → only PII leaks (email, name). No credentials exposed because session keys never leave the browser.

### Files touched this session

Committed (79754a2):
- `apps/server/src/lib/swarm/feeds.ts` — added `readFeedPageStrict` + `FeedReadStrictResult` discriminated union
- `apps/server/src/lib/site/service.ts` — empty-guard memo + `readCreatorSitesStrict`
- `apps/server/src/lib/event/service.ts` — empty-guard memo (both `getCreatorEvents` + `_dirCache`) + `readDirectoryStrict`
- `apps/web/src/lib/api/creator-cache.ts` — new SWR wrappers
- `apps/web/src/lib/cache/cache.ts` — `USER_SCOPED_PREFIXES` + `cacheClearByPrefix`
- `apps/web/src/lib/auth/auth-store.svelte.ts` — cache clear on logout
- `apps/web/src/lib/creator/home/CreatorHome.svelte`, `dashboard/{Dashboard,DashboardIndex}.svelte`, `builder/MultiSiteBuilder.svelte`, `builder/tabs/{EventsTab,TemplateTab}.svelte` — SWR adoption

Uncommitted:
- `apps/server/src/middleware/auth.ts` — nonce replay blacklist (described above)

### Deploy reminders pulled from memory

- SSH-then-curl-localhost for health checks. Never curl laptop hostname.
- `mf8-server` coexists on the deploy host. Identify WoCo processes via `/proc/PID/cwd` before killing.
- `apps/server/.env` on laptop IS master — synced to server every deploy.
- One short health+ps check after restart. No chained sleep loops.
