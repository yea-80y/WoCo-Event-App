# Feed-Signer Escrow — SUPERSEDED (work shipped)

**Status:** DONE. This pre-implementation handover is kept only as a redirect.

The feed-signer escrow it describes is wired and audited (2026-06-30). Shipped in
`19c7e6d` (portability carrier) + `f8a1a18` (guardian-bundle seal/restore + `feed-signer-store.ts`).

**The "one decision" (A vs B) was resolved as (A): derive-then-escrow** — low blast radius,
no existing feed ADDRESS changes. External wallets (web3/CSW), which cannot derive, take a
key SOURCE in later chats (web3: sign-to-derive; CSW: random + escrow, parked).

For the current state, the security audit, and the exact wiring sites (file:line), see
`CLIENT_FEEDS_AUTH_KINDS_HANDOVER.md` → section "Escrow IS wired". Live cross-device
verification is still owed per `RECOVERY_VERIFICATION_CHECKLIST.md`.
