# POD Manager — Sonnet Handover

Status: 2026-06-03. Opus has locked the Step-4 design, the holdings primitive,
the server API, and the **hero UI atoms**. This is the handover for the
remaining mechanical UI. Read `docs/WOCO_SHOP_PLAN.md §4` first for the model.

**Golden rule (model split):** anything that **signs a manifest, enrols a POD
on-chain, evaluates a gate, or moves funds is Opus** — do NOT implement it.
Everything below is "render the locked data + call the locked API." If a task
seems to need ed25519 signing / `registerEvent` / a sponsor tx, STOP and flag it.

---

## What's already built (don't rebuild)

**Shared** (`packages/shared/src/pod/`)
- `types.ts` — `PodKind`, `PodDisplayMetadata`, `PodCategory`, `PodDirectoryEntry`,
  `PodDirectory`, `PodHolding`, `PodGateRule`.
- `gate.ts` — `evaluatePodGate(holding, rule, now)` (pure; use it for client-side
  gate previews). `topics.ts` — `podCreatorDirectoryTopic`.

**Server** (mounted `/api/pod`)
- `GET /api/pod/mine` → `PodDirectory` (auth). `PUT /api/pod/categories`
  `{categories}` (auth). `GET /api/pod/holdings?holder&onChainEventId&manifestRef&chainId`
  → `PodHolding` (public).
- Tickets auto-populate the directory on `confirmSeriesOnChain` — no backfill.

**Frontend**
- `lib/api/pod.ts` — `getMyPods()`, `setPodCategories(cats)`, `getPodHolding(params)`.
  (`authPut` added to `lib/api/client.ts`.)
- `lib/components/pod/PodCard.svelte` — THE locked atom. Props:
  `{ pod, variant: "grid"|"picker", categoryLabel?, selected?, onSelect? }`.
  Signature detail = the lime **allocation hairline** (issued/supply). Reuse it
  everywhere; do not restyle it.
- `lib/components/pod/PodManager.svelte` — the `#/creator/pods` shell: data load,
  category filter chips, grid, empty/loading/error states. Route `creator-pods`
  wired in `router.svelte.ts` + `CreatorApp.svelte`.

---

## Design language (match exactly — see CLAUDE.md feedback_avoid_claude_default_look)

Concrete & Acid, dark. Use `var(--token)` only, never hardcoded hex. Acid lime
`--accent` is the SINGLE affordance/selected surface. Vermillion `--error` =
destructive only. Fonts: `--font-display`/`--font-body` (Space Grotesk),
`--font-mono` (JetBrains Mono) for numbers, `--font-tag` (Bungee) for kind chips.
Radii 2/4/8. Mirror `PodManager.svelte`'s `.btn`, `.fchip`, `.empty-state`,
`.skeleton` classes in new screens.

---

## TO BUILD (Sonnet)

### 1. Category management UI  *(pure CRUD — fully Sonnet)*
A small editor (modal or inline panel off the manager header) to create / rename /
reorder / delete `PodCategory[]`. Persists via `setPodCategories(cats)`. `id` is a
stable ULID (generate with the same util shops use); `sortIndex` from list order.
After save, reload `getMyPods()` so filter chips refresh. Re-categorising a POD is
display-only (no re-sign) — see task 3.

### 2. `<PodPicker>` component  *(Sonnet)*
`lib/components/pod/PodPicker.svelte` — wraps `PodCard variant="picker"` for
selecting POD(s) when configuring an event gate or a product reward/gate.
- Props: `{ selected: string[] (manifestRefs), multiple?: boolean, kindFilter?: PodKind[], onChange }`.
- Loads `getMyPods()`, optional category filter, renders the picker rows, manages
  selection, emits the chosen `manifestRef`(s). Empty state → link to `/creator/pods`.
- This is the seam step 2 (gating) plugs into — keep it self-contained.

### 3. POD detail / edit drawer  *(Sonnet, with ONE small server add)*
Open from `PodManager`'s `onSelect`. Edits the MUTABLE display fields only —
`name`, `image`, `categoryId`, `description` (these live in the directory entry,
NOT the signed manifest, so editing is safe & needs no signing).
- Needs a thin server endpoint to patch one entry: add `PUT /api/pod/:manifestRef`
  that owner-checks then calls `upsertCreatorPod` with the merged entry. This is a
  relay following the `PUT /categories` pattern — Sonnet-safe (NO signing). Add
  `updatePod(manifestRef, patch)` to `lib/api/pod.ts`.
- Artwork upload: reuse the existing image-upload endpoint shops/sites use
  (`uploadSiteImage` style) to get a Swarm ref for `image`.
- Show read-only facts: kind, `manifestRef`, supply, `issuedCount`, `eventId`,
  and a "View holders" stub (holders list is a later attendee-side piece).

### 4. CreatorShell nav entry  *(trivial)*
Add a "PODs" destination to `CreatorShell.svelte` nav → `navigate("/creator/pods")`,
and a "Create POD" entry to the Create action sheet if appropriate. Match the
existing nav button markup.

---

## OPUS-RESERVED (do NOT build — flag if blocked on these)

- **Create badge / collectible POD** (the manager's `onCreate`): real issuance =
  build pod bodies → Merkle tree → ed25519-sign manifest → upload → on-chain enrol
  → directory upsert. This is **Step-3 (loyalty) Opus work**. For now `onCreate` is
  a logged stub. Sonnet may build the modal *form shell* (name/artwork/supply/
  category inputs + validation) but must leave the submit calling a TODO — the
  issuance service/endpoint is Opus.
- **Gate enforcement** at claim/order (server holdings check) — Step-2 Opus.
- **Loyalty milestone badge issuance** — Step-3 Opus.

---

## Verify
- `npm run build:server` (server) + `npm run check -w @woco/web` (web) must stay green.
- Manual: publish an event → its ticket appears at `#/creator/pods` after on-chain
  confirm. Category chips filter. Picker selection toggles the lime check.
