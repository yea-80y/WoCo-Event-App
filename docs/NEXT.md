# NEXT — the working order

The single ordered list. GitHub issues are the *what*; this is the *when*. If a plan only
exists in a chat message, it does not exist. Update this file when the order changes.

Last updated: 2026-07-14.

---

## Now — in flight

| # | Item | Owner | State |
|---|---|---|---|
| 1 | **Merge PR #51 + deploy** — close the crypto rail at *claim* time | — | The #40 flag gated event **creation** only; events published before it still offered crypto. Adds `agentCommerceAllowed` kill switch. |
| 2 | **Frontend deploy** (`npm run deploy`) — main carries `PublishButton` + `creator-cache` changes from #40, plus #51's ClaimButton gate | **user** | Server side already live; frontend is the lagging half. Deploy server **before** frontend. |
| 3 | **Verify #33** — door-scanner roster re-push, against the deployed server | **user** | Reopened: #40 auto-closed it on a keyword, but the fix was only hypothesised. |
| 4 | **Batch routing (#48)** + production cutover | **Fable** | Deferred — picked up later. Spec: `PLATFORM_SIGNER_AUDIT.md` § "Batch routing". |
| ~~—~~ | ~~Merge PR #46~~ | — | ✅ merged `d36a88c` |
| ~~—~~ | ~~Close #42~~ | — | ✅ closed — profile already client-signed |
| ~~—~~ | ~~Merge PR #40 (exactly-once registration) + #49 (docs)~~ | — | ✅ merged `edb6993` / `0dfc729`; **server deployed**. Closed #36, #14. |

## Next — cut over to production

The current batch `9ef3373b…` holds **test data**. The plan is to let it die, not to save it.

| # | Item | Issue |
|---|---|---|
| 4 | Fresh **production postage batch** (real depth + TTL, not test values) | #45 |
| 5 | Fresh **production events directory feed** so test events don't show | — |
| 6 | **TTL monitoring + auto-topup/dilute** so no batch ever silently expires again | #45 |
| 7 | Stripe purchase gate for user batches (retire `FREE_HOSTING`) | #44 |

> Ordering matters: re-route (1) and cut over (4,5) **before** the old batch expires — you can only
> re-stamp what you can still read. In testing this is slack; at launch it is a hard deadline.

## Launch blockers — money + correctness

| # | Item | Issue |
|---|---|---|
| 8 | Event directory does not scale — every publish rewrites every page | #37 |
| ~~—~~ | ~~Publish is not resumable — a failed register forks a second event~~ | ✅ #36 |

**#41 is no longer a launch blocker.** Crypto is not surfaced for launch, and PR #51 makes that
true *in code* rather than as a side effect of the directory cutover. The rail is not deleted —
it is off behind `FEATURES.cryptoPaymentsAllowed`, one line from coming back.

Two things must be true before crypto (or the agent rail) is promoted again:
- Claims must mint on-chain, not Swarm-only, or a paying buyer gets a weaker ticket than a Stripe buyer.
- **#41 must cover the agent rail too** (`/api/agent/buy` settles USDC on-chain then mints via
  `claimTicket()` — same defect). Fixing only the consumer rail leaves the agent one broken.

## Bugs from testing round 1

| # | Item | Issue |
|---|---|---|
| 10 | Door scanner: re-pushed roster not picked up on refresh — **fix shipped, unverified** | #33 |
| 11 | Referral link UX — silent capture needs visible feedback | #34 |
| 12 | Creator dashboard shows the same event twice — **not a bug**: two real events from a retried publish. Root cause (#30, #36) is fixed; close after a clean publish run confirms it | #32 |
| ~~—~~ | ~~Dashboard 404s on unlisted client-signed events~~ | ✅ #14 |

## Hygiene

| # | Item | Issue |
|---|---|---|
| 15 | Node 24 bump on the VM (**Node 20 is EOL**) | #9 |
| 16 | `svelte-check` green + in CI | #11 |
| 17 | dist-multisite purge on the VM (20MB → 8.4MB) | #47 |
| 18 | bee-js `11.1.0 → 12.3.1` — fold into #45 (it fixes `extendStorage` no-op, `calculateTopUpForBzz`, adds `minimumValidityBlocks`) | — |
| 19 | bee node `2.8.0 → 2.8.1` — crash-safe chunk store. Insurance, not urgent (0 restarts in 47d) | — |

## Deferred / v2

#43 shop config · #12 referral payout · #13 resale + Stripe recipient rail ·
#28 ECIES golden vectors · #31 ZeroDev gas workaround · #8 browser-verify #1–#4
