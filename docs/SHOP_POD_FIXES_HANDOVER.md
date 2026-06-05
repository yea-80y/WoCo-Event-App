# Shop + POD fixes — implementation handover (for Sonnet)

Diagnosis done on Opus 2026-06-04. Four work items, all spec'd below. Branch `feat/woco-shop`.
Commit at each numbered milestone (small revertable commits — see memory).

---

## 1. POD image shows broken  — TRIVIAL

Root cause: images upload via `uploadToBytes` → a raw Swarm **/bytes** reference (not a
manifest), but PODs render it as `/bzz/{ref}/` which only resolves manifests.

Working reference pattern: `UserAvatar.svelte:38` uses `${GATEWAY}/bytes/${ref}` (no trailing slash).

Fix — change `/bzz/${ref}/` → `/bytes/${ref}` in:
- `apps/web/src/lib/components/pod/PodCard.svelte:40` (`imageUrl` derived)
- `apps/web/src/lib/components/pod/PodCreateModal.svelte` `previewSrc` (the `${BEE_GATEWAY}/bzz/${image}/` line)
- Anywhere else a POD/product `imageRef` is rendered with `/bzz/` (grep `bzz/${`).

Verify: upload an image in PodCreateModal → preview must render, and PodCard in the manager.

---

## 2. Shop Stripe return: no success screen + no email  — TWO BUGS

### 2a. Missing success route
Stripe redirects to `…/#/shop/{shopId}/order/{code}?stripe=success&session_id=…`
(`apps/server/src/routes/shops.ts:483`). The router (`apps/web/src/lib/router/router.svelte.ts`)
only knows `/shops/:id/tap` → no match → bounces to the shop. Note the deployed storefront the
user tested runs on `gateway.etherna.io/bzz/{hash}/` — confirm WHICH runtime/app serves the
standalone shop (newSiteFromShop, commit 7c4a8ce) and add the route THERE too, not only the main app.

Add:
- Route match `^/shop/([^/]+)/order/([^/]+)$` → `{ route: "shop-order", params:{ shopId, code }, surface:"attendee" }`.
- A `ShopOrderScreen.svelte` (mirror the email-only optimistic ticket card pattern): reads
  `?stripe=success`, shows "Payment confirmed — order {code}", pickup code, optional poll of
  `GET /api/shops/:id/orders/:orderId` for paid status. Handle `?stripe=cancelled` too.
- Wire it into AttendeeApp.svelte AND the deployed-shop runtime shell.

### 2b. No confirmation email
`handleShopOrderPaid` (`apps/server/src/routes/stripe.ts:718`) only flips status→paid; it sends
NO email. There is no shop email sender (only `sendTicketEmail` in `routes/tickets.ts:165`).

Add `sendShopOrderEmail()` (new fn near sendTicketEmail or a `lib/email/shop-receipt.ts`):
- Buyer email source: `session.customer_details?.email` (already read at line 737).
- Contents: shop name, line items (name × qty × price), total, pickup/order code, merchant contact.
- Use existing Resend client (`lib/email/client.ts`) + `PUBLIC_API_BASE` for any links.
- Call it from `handleShopOrderPaid` AFTER the order is marked paid; fire-and-forget + log on failure
  (mirror ticket email error handling). Do NOT block the webhook 200.

Verify with Stripe test card (use `/stripe test-cards` skill).

---

## 3. Product image upload  — UI ONLY (schema already supports it)

`Product` already has `imageRef?: Hex64` + `imageRefs?: Hex64[]` (`packages/shared/src/shop/types.ts:115`).
Gap: `ShopCatalogEditor.svelte` has no upload control.

- Reuse `uploadSiteImage()` (`apps/web/src/lib/api/sites.ts`) — same endpoint POD uses.
- Add a thumbnail + "Upload image / Replace / Remove" control per product row (copy the
  PodCreateModal `pickImage`/`removeImage` block + `.upload-zone` styles).
- Render product image with `/bytes/${imageRef}` (NOT `/bzz/`, see item 1) in ProductCard/Storefront.
- Keep ≤4MB client guard consistent with server.

---

## 4. Event/product gating by attendance + held PODs  — DESIGN + PHASED BUILD

Existing: `PodGateEditor.svelte` gates ONE on-chain POD with `minCount`. Server enforcement in
`apps/server/src/lib/pod/gate-check.ts` (`checkPodGate`, `validatePodGate`) + pure
`evaluatePodGate` in `packages/shared/src/pod/gate.ts`. `PodGate` already carries
`notBefore`/`notAfter` (time window) — just no UI.

"Attended certain events" == holding that event's ticket POD. Ticket PODs are already
auto-upserted into the creator's POD directory (commit 31c768b), so `getMyPods()` already
returns them — the picker just needs multi-select.

### Schema (packages/shared/src/pod/types.ts) — add, keep `PodGate` as-is for back-compat:
```ts
export type GateWindow =
  | { kind: "always" }
  | { kind: "time"; notBefore?: number; notAfter?: number }
  | { kind: "firstN"; n: number }        // first N claims of THIS tier are holder-only, then open
  | { kind: "reserved"; reserved: number }; // reserve N of supply for holders; rest open in parallel

export interface PodGateGroup {
  mode: "any" | "all";   // hold ANY one of / ALL of `gates`  (organiser chooses — user decided)
  gates: PodGate[];
  window?: GateWindow;   // default { kind: "always" }
}
```
Series/product gate field widens to `PodGate | PodGateGroup`. Add a pure
`normalizeGate(g): PodGateGroup` shim so old single-gate data still enforces. Put group
evaluation (any/all + window) in `packages/shared/src/pod/gate.ts` with unit tests
(mirror existing `gate.test.ts`).

### Phasing (ship in order; commit between):
- **Phase 1 — `always` + `time` + multi-POD any/all.** Pure predicate; no claim counting.
  - `PodGateEditor`: multi-select PODs (already lists ticket + created PODs), any/all toggle,
    window picker showing only Always / Time for now. Emit `PodGateGroup`.
  - `checkPodGate` → evaluate the group; fail-closed unchanged. `validatePodGate` loops `gates`.
- **Phase 2 — `firstN`. SHIPPED 2026-06-05 (commit 2ac87fc), EVENTS ONLY.**
  - Window now resolves to a 3-way PHASE in `gate.ts`: `holders-only` / `open` / `closed`
    (`computeGatePhase`). `evaluatePodGateGroup` takes a `GateEvalContext` ({ now, tierClaimed })
    — `firstN` is holder-only early access while committed `tierClaimed < n`, then `open` to all.
  - `claims.ts` + `stripe.ts`/create-checkout branch on phase. `tierClaimed` read via
    `getClaimStatus(seriesId).claimed` only when `gateNeedsClaimCount` (firstN); always/time skip it.
  - No mutex/reservation changes — firstN is monotonic-safe (committed count only rises; a passing
    non-holder always lands on slot ≥ n; card is blocked during the holders-only phase for
    non-holders anyway). Decision rationale in the commit + CLAUDE.md.
- **Phase 2b — `reserved`. DEFERRED (user call, 2026-06-05).** Type kept in schema; treated
  fail-safe `holders-only` (unenforced) by `computeGatePhase`. Needs holder/non-holder claim
  accounting + an in-queue atomic counter (the boundary IS racy). Revisit on real demand.

**KEY DESIGN CORRECTION (user, 2026-06-05): gate binds to the ACCOUNT, payment is a separate rail.**
The old "a wallet gate is unsatisfiable by card" assumption was wrong — it conflated *proving POD
holdings* (account) with *paying* (rail). For EVENTS: a gated series in `holders-only` phase now
requires the buyer to be a signed-in account whose verified wallet passes the gate, after which
they pay by **card OR crypto**. The card claim binds to the verified wallet via
`metadata.claimerAddress` (already threaded; webhook claims to it). This also closed a hole where
the Stripe path bypassed event gates entirely. SHOP product rail (`firstGatedProduct`) left as-is
(still reject-card) — separate decision, deliberately out of scope to avoid scope creep.

Enforcement entry points to update: `claim-service.ts` (events) and the shop order paths that
already call `checkProductGates`. Keep "server uses VERIFIED holder address only" invariant.
