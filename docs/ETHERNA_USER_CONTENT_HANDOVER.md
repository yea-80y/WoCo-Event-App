# User Content → Etherna Batch Routing (handover, 2026-07-14)

Facts below verified by reading source (cited `file:line`). Written by Fable for an
implementation pass; the two LANDMINES are correctness bugs waiting to happen — read
them before writing any code.

## Policy (decided, do not relitigate)

- **WoCo bee + WoCo batch**: platform infrastructure ONLY — frontend, global event
  directory + creator index, platform-signed feeds (`writeFeedPage` writes), ENS-served
  content. The directory STAYS here: it is platform-signed/paid either way, it is the
  hottest read path, Etherna's Beehive can't serve our `/feeds` (401s anonymously,
  `soc-upload.ts:23`), and ENS needs the WoCo gateway regardless.
- **Etherna**: ALL user-owned content — profile data SOC, avatar SOC + avatar image
  bytes, and (later) any other client-signed user feed. Batch choice per write:
  the user's own Etherna batch if registered, else `ETHERNA_PLATFORM_BATCH`.
  `batchForDeploy` with `deployType:"event"` + an Etherna `gatewayUrl` already
  implements exactly this policy (`lib/etherna/batch-router.ts:67-80`).
- **Reads are multi-source forever.** SOCs are self-authenticating (sig re-verified
  against owner, `client-soc.ts:89-98`) and `/bytes` content is content-addressed, so
  extra read sources add availability with ZERO added trust. There is no "one gateway".

## Current state (verified)

- Profile data + avatar are **already client-signed** when the user has a content-feed
  signer: `apps/web/src/lib/api/profiles.ts:172-226` (data), `:229-274` (avatar).
  The platform write (`profile/service.ts:79`) only fires on the no-signer legacy
  fallback (`profiles.ts:176-183`) — CSW etc. Leave that fallback alone.
- But the client passes **no `gatewayUrl`** to `writeContentFeed`, so
  `/api/swarm/soc` routes to the **WoCo platform batch**
  (`routes/swarm.ts:45-49` → `batch-router.ts:59-64`).
- Avatar image bytes: `routes/profiles.ts:145` → `uploadAvatar` service →
  `uploadToBytes(imageData)` with **no selection** → WoCo batch
  (`lib/swarm/bytes.ts:104` falls back to `requirePostageBatch()`).
- Server-side SOC reads already fall back to Etherna with bearer auth + sig
  re-verify + offer self-heal (`soc-upload.ts:287+`, `readSocFromEtherna`).
- Server-side bytes reads already RACE WoCo + Etherna (`bytes.ts:202-228`).
- Client image reads have a multi-gateway candidate helper
  (`apps/web/src/lib/components/site/image-fallback.ts`, WoCo + Etherna).

## LANDMINE 1 — RETRACTED (2026-07-14): Etherna DOES reach the public net

This section previously claimed "Etherna Beehive chunks never reach the public net",
citing the `soc-upload.ts` comment. **That claim was false and has been removed from
the code.** Measured 2026-07-14: a chunk AND a real SOC, both stamped via
`gateway.etherna.io`, were retrievable from the WoCo bee (`GET /chunks/{addr}` → 200)
within seconds of upload. Uploading to a Bee node IS pushing into the network — the
chunk lands with the storer neighbourhood, not the uploader — so there was never a
propagation gap to design around.

The real defect the false claim caused: `soc-upload.ts` deliberately SKIPPED the
gateway whitelist for Etherna-stamped SOCs (`if (!etherna) whitelistHashes(...)`),
on the reasoning that a whitelist "would only convert a fast 403 into a slow futile
search". So any Etherna-stamped SOC 403s on `gateway.woco-net.com` forever
(reproduced 2026-07-14 with a fresh SOC). API reads survive it (`client-soc.ts:109-117`
already falls through to the server fallback on 403); a DIRECT gateway load
(`/bzz/{feedManifest}`) has no fallback. **Fixed: both rails now whitelist.**

Scope: this is a LATENT bug on the Etherna-routed path, not the cause of the old
"website feed 403". Sites only stamp on Etherna when the Etherna gateway is picked
(`batch-router.ts`); WoCo-gateway deploys use the platform batch and were always
whitelisted — those sites load, and that historical 403 was fixed separately.

Still true and worth keeping: the server's `readSocFromEtherna` fallback. Not as a
routing workaround, but as a backstop for the retrieval window — Etherna's gateway
holds the chunk locally and answers while a just-pushed chunk is still settling.

## LANDMINE 2 — versioned-sequence split-brain = silently lost writes

Existing profiles have versions 0..N stamped on WoCo. After the switch, version N+1
lands on Etherna only. `writeContentFeed` resolves "latest" by probing with `readSoc`
(`content-feed.ts:162-165`). A prober that can only see WoCo stops at N → computes
next = N+1 → uploads a SOC whose address ALREADY EXISTS on Etherna → **Bee dedupes
silently and keeps the old payload** (`content-feed.ts:114-117`). The user's edit is
lost with a success response. Dual-source reads are therefore **correctness-critical
for the write path**, not an availability nicety. Fix Landmine 1 first; the write
path inherits it via the same `readSoc`.

Verified resolver semantics (`packages/shared/src/swarm/soc.ts:379-402`): probes
forward from the hint in windows of `VERSION_PROBE_WINDOW = 2` (`soc.ts:364` — do
NOT widen it; W=8 melted the bee 2026-07-06) and **stops at the first missing
version**. It explicitly assumes versions are "contiguous from 0 and immutable (a
version once written can never disappear)" (`soc.ts:373-377`). A store split breaks
exactly that assumption unless every probe sees both stores.

## Implementation order

1. **Client read fallback** (Landmine 1): `client-soc.ts` — on 404, fall through to
   the server SOC read for content-feed topics. Verify version probing still behaves
   (see the probe-cost history: `project_versioned_feed_probe_cost`, W=2 + hints).
2. **Profile data + avatar SOC writes → Etherna**: pass the Etherna gateway URL from
   `profiles.ts` `updateProfile`/`uploadAvatar` into `writeContentFeed` (plumbing
   exists end-to-end: `content-feed.ts:132` → `client-soc.ts:54` →
   `routes/swarm.ts:45`). Test the v(N)-on-WoCo → v(N+1)-on-Etherna transition on a
   REAL existing profile before deploy.
3. **Avatar image bytes → Etherna**: `routes/profiles.ts:145` avatar path builds a
   `batchForDeploy` selection and passes it to `uploadToBytes` (already accepts one,
   `bytes.ts:97`). Skip the WoCo-proxy whitelist for Etherna-target writes (offers are
   the Etherna equivalent — registered inside `uploadBytesToEtherna`, `bytes.ts:55`).
   THEN fix the reader: `UserAvatar.svelte:17,38` reads `/bytes/{ref}` from a SINGLE
   gateway (`VITE_GATEWAY_URL` || gateway.woco-net.com) — switch it to
   `imageUrlCandidates()` fallback (`image-fallback.ts`), which already emits
   WoCo + Etherna candidates.
4. **Sweep other user-content writes** for the same routing (shop config when it
   ships, any future client SOC) — grep `writeContentFeed(` callers and check which
   pass `gatewayUrl`.

## Non-goals / accepted trade-offs

- No migration of old versions: v0..N stay stamped on the WoCo batch, which stays
  alive for the frontend + directory anyway. Feed continuity for hint-less readers
  depends on those old chunks surviving: the resolver scans from 0 and stops at the
  first gap (`soc.ts:387-400`), so expired early versions make the whole feed
  unresolvable for a reader with no hint. Flag before ever shrinking the WoCo batch.
- Etherna is NOT a silo (retracted 2026-07-14 — see LANDMINE 1): its stamped chunks
  land on the public net and any bee retrieves them. Availability is therefore normal
  Swarm availability (postage-batch lifetime), not Etherna-dependent. What IS
  Etherna-specific is the ANONYMOUS-READ offer gate on Etherna's own gateway (402
  without an offer) — that's an Etherna access-control policy, not a network boundary.
- `/api/swarm/soc` today lets any authenticated user stamp on the WoCo platform batch
  by omitting `gatewayUrl` (`routes/swarm.ts:45-49`). After this work, consider
  defaulting user-content stamps to Etherna server-side instead of trusting the
  client's gateway signal. Separate hardening task.
