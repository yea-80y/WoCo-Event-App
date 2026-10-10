# Event-Creation Anti-Abuse Gate — Design / Build Plan

**Status (2026-10-05):** design, not started. Verified against `main` (94364b56). The hole this
doc set out to close (ungated crypto-only events) is shut for now by flags, not by this gate:
crypto and free events are off, so **every publishable event needs Stripe verification**, and
organising needs a **passkey account** (#768). The EAS substrate the recommendation reuses is
deleted (#475, #476): likes and follows are Swarm-native and need the same unlock as a name
(a ticket, Stripe verification or a confirmed invite, #753). The design below still holds as the
answer for when crypto-only or free events return. Read §5 and §10 with that in mind.

**Context (2026-06-17):** we briefly used "Stripe verified" as a universal gate on event
creation, then relaxed it — Stripe is the wrong tool for abuse prevention. This doc specs the
*right* gate for production.

---

## 1. The conflation to avoid

Two different questions got merged. Keep them separate:

| Concern | Right gate | Applies to |
|---|---|---|
| "Can this organiser take card money / are they KYC'd for fiat payout?" | **Stripe verification** (`charges_enabled`) | **Card events only** |
| "Is this an accountable human who won't spam/abuse event creation?" | **Stake and/or proof-of-humanity** | **All event creation** (esp. crypto-only) |

Using Stripe for the second question is wrong: it forces crypto-native organisers into Stripe
(against the point of a crypto-only event) and is a weak sybil gate anyway (test accounts are
free). So Stripe stays scoped to card payments; abuse prevention gets its own gate.

## 2. Current state (2026-10-05)

- **Every event is a card event.** `cryptoPaymentsAllowed` and `freeEventsAllowed` are false
  (`packages/shared/src/features.ts`), so the server refuses a series without a price of at
  least `MIN_TICKET_PRICE` and a payment rail, and refuses crypto outright (`routes/events.ts`).
- **Card event** → Stripe verification required (up-front `StripeVerifyGate` prompt + Publish
  gate; server live-checks `charges_enabled` in `events.ts` `hasStripeSeries`).
- **Organiser account** → passkey only (#768): the organiser area opens only for a passkey
  account, and Stripe connect refuses anything but a smart account.
- **Crypto-only event** → impossible while the flag is off. Before that it was **ungated**; that
  hole returns with the crypto rail unless this gate ships first.
- Stripe is still a card gate, not an abuse gate - the conflation in §1 stands.

## 3. Goals & non-goals

**Goals**
- Raise the cost of mass/spam/sybil event creation to a level that deters abuse without
  blocking legitimate organisers.
- Crypto-native and on-theme for Arbitrum; privacy-preserving where possible.
- Reusable: the same "verified human" signal should also feed the **gasless-sponsorship
  eligibility gate** for EAS likes (an existing unbuilt TODO — see [[project_eas_likes]]),
  so we build the primitive once. *(Superseded: EAS likes are deleted; likes and follows are
  Swarm-native, chain-free, and gated by the attendee unlock - docs/SWARM_SOCIAL_PLAN.md.)*

**Non-goals**
- Not KYC. We don't want or store identity PII (privacy + liability). PoH must be ZK.
- Not a paywall on event creation — the free path must stay open to real humans.

## 4. Options

### Option A — Small refundable stake
Organiser locks a small stake (e.g. $1–5 USDC, or ETH) at creation; released after the event
concludes / a clean window, forfeit-able on substantiated abuse.
- **Pros:** simplest; crypto-native; immediate sybil cost = capital; no identity dependency.
- **Cons:** capital friction (needs funds upfront); a *funded* attacker can still spam; needs
  slashing/dispute logic (who adjudicates abuse?) + refund mechanics; tiny stakes deter casual
  spam only.
- **On Arbitrum:** cheap; reuse the USDC + spend-permission / escrow patterns we already run.

### Option B — Proof-of-humanity (Self protocol / zkPassport)  ← recommended primary
ZK proof of a unique real passport/ID, no PII on-chain. A per-identity **nullifier** bounds how
many events one human can create.
- **Self protocol:** passport NFC scan → ZK proof verified on-chain (Arbitrum verifier / hub);
  yields a uniqueness nullifier + optional attributes (age/nationality) without revealing them.
- **zkPassport:** similar ZK-passport approach; evaluate both for Arbitrum support + UX.
- **Pros:** strong sybil resistance (1 human → bounded events); privacy-preserving (ZK, no PII
  stored); no capital friction; reusable across the app; strong Arbitrum-native narrative.
- **Cons:** onboarding friction (passport + NFC phone); excludes the passport-less; provider
  dependency/liveness; must design nullifier-reuse + revocation policy.

### Option C — Hybrid (recommended end-state)
**PoH as the primary "verified human" credential** → unlocks a **free allowance** of event
creation (and gasless-like sponsorship). **Stake as a secondary/booster** path: users who can't
/won't do PoH, or who want higher limits, post a stake instead. Plus per-identity rate limits.

## 5. Recommendation

> Superseded in part (2026-10-05): EAS is gone from the tree (#476; `no-eas.test.ts` fails CI on
> any EAS symbol) and social subjects key by account address, not name namehash. A
> `verified-human` record would be a Swarm-native signed record like the campaign records
> (`packages/shared/src/campaign/records.ts`), not an attestation. The PoH-primary reasoning
> stands.

Lean **PoH-primary, recorded as an EAS attestation**, with stake as a fallback/booster:

1. Verify humanity once via Self/zkPassport → write a **`verified-human` EAS attestation**
   (subject = the organiser's profile sub-ENS namehash / address; ZK nullifier as the dedup
   key). EAS is already our social-graph substrate — reuse it.
2. **Gate event creation** on: holds a valid `verified-human` attestation **OR** has an active
   stake. Enforce a **rate limit per identity** (events / time) on top.
3. **Reuse the same attestation** to gate gasless-like sponsorship (kills the open likes TODO
   with the same primitive).
4. Keep **Stripe orthogonal** — only for card payouts.

This makes "verified human" a single cross-cutting capability (creation + likes sponsorship),
on-theme for Arbitrum (ZK + EAS + Stylus already in the stack), and privacy-preserving.

## 6. Mechanism sketch

- **Frontend:** a "Verify you're human" step (Self/zkPassport SDK) in the creator onboarding;
  on success the proof is submitted and the EAS attestation written (gasless via the Kernel
  session-key rail). A stake step as the alternative path.
- **Contracts/verifier:** Self/zkPassport on-chain verifier on Arbitrum; a small staking
  contract (lock/release/slash) if Option A/C. Consider a Stylus verifier path for the
  compute-heavy ZK check (consistent with the existing aggregator) — evaluate.
- **Server (`events.ts`):** at publish, require (valid `verified-human` attestation for the
  parent) OR (active stake) — verified ON-CHAIN, mirroring the existing Stripe live-check
  pattern. Rate-limit per identity. Keep it a thin verify layer (truth on-chain), per
  [[feedback_client_first_architecture]].
- **Lock-step with `FEATURES`:** gate both client UI and server validation off the same flag so
  an old client can't bypass (same discipline as `cryptoPaymentsAllowed`).

## 7. Abuse model
- **Sybil via many identities:** PoH nullifier bounds 1 human → N events; stake adds capital
  cost. Combined, both must be paid to scale abuse.
- **Funded single attacker:** stake-only is weak here; PoH nullifier is the stronger bound.
- **PoH provider compromise / liveness:** keep the stake fallback so creation never hard-depends
  on one provider; allow manual review for edge cases.
- **Replay / nullifier reuse:** dedup on the ZK nullifier; define revocation (e.g. on confirmed
  abuse) carefully — revocation must not deanonymise.

## 8. Effort & phasing
- **Phase 0 — spike (1–2d):** evaluate Self vs zkPassport on Arbitrum (verifier availability,
  SDK maturity, NFC UX); confirm we can mint an EAS attestation from the proof.
- **Phase 1 — stake stopgap (3–5d):** simple lock/release staking contract + create-flow step +
  server check. Ships sybil friction fast, no identity dependency. (Optional if going straight
  to PoH.)
- **Phase 2 — PoH primary (1–2wk):** Self/zkPassport integration → `verified-human` EAS
  attestation → gate event creation + reuse for gasless-like sponsorship; rate limits.
- **Phase 3 — hybrid polish:** allowances, booster stake, dispute/slash, analytics.

Not funds-critical like recovery, but it touches the spam/Sybil surface and the EAS graph — test
the nullifier-dedup + server enforcement carefully.

## 9. Open questions
- Self vs zkPassport (or both) — Arbitrum verifier + UX + passport coverage.
- Free allowance size per verified human; rate-limit windows.
- Stake amount + asset (USDC vs ETH) + release/slash policy + who adjudicates abuse.
- Should `verified-human` be a profile-bound attestation (sub-ENS namehash) or address-bound?
- Migration: existing organisers — grandfather, or require verification on next create?

## 10. Integration points (as of 2026-06; partly stale)

Still valid: `routes/events.ts`, `EventForm.svelte` / `SiteBuilder.svelte` (`SiteBuilder.svelte`
now lives at `apps/web/src/lib/creator/SiteBuilder.svelte`), `features.ts`. Gone: the
`likes/*` paths (deleted with the EAS rail, #475). `[[...]]` links are private notes, not
repo files.

- `apps/server/src/routes/events.ts` — publish gate (add the human/stake check alongside the
  existing Stripe `hasStripeSeries` check; keep them independent).
- `apps/web/src/lib/creator/events/{EventForm,SiteBuilder}.svelte` — create-flow hosts (add the
  verify step + Publish gate, mirroring the `anyCardEnabled` / `StripeVerifyGate` pattern).
- `packages/shared/src/features.ts` — flag to roll the gate client+server in lock-step.
- EAS: `packages/shared/src/likes/*` + `apps/server/src/lib/likes/*` — reuse the attestation
  substrate; ties to the gasless-sponsorship TODO in [[project_eas_likes]].
- Plan refs: [[project_referrals]] (EAS schema slot), [[project_stylus_aggregator]] (ZK verify
  via Stylus?), [[feedback_crypto_expert_posture]].
