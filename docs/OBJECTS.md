# Objects

What a WoCo **object** is, how it differs from a verifiable credential, and why it is not called
a POD. The mechanics (byte layouts, Merkle scheme, the door) live in
[TICKETING.md](./TICKETING.md); this page is the concept. Verified against `main` (94364b56) on
2026-10-05.

---

## What an object is

Signed data an issuer publishes, that anyone can check without asking WoCo. Today that means
**tickets**. The same machinery issues certificates and badges, but badge creation is switched
off (`badgesAllowed = false`) and the certificate rail is outside launch scope.

| Format | Used for | Code |
|---|---|---|
| `woco.manifest.v2` + `woco.edition.v1` | Tickets (and badges, when enabled) | `packages/shared/src/edition/` |
| `woco.cert.v1` + `woco.cert-challenge.v1` | Awarded certificates | `packages/shared/src/cert/` |

## How a ticket object works

- **One signature per batch.** The organiser's issuing key signs one manifest committing to a
  Merkle root over every ticket in a ticket type, whether there are 10 or 10,000. The key is not
  needed again, so tickets sell while the organiser is offline and the platform never holds it.
- **Supply is fixed per batch and public.** The manifest commits to the exact count, and its
  digest is registered onchain (`manifestRef`). A ticket outside the batch does not verify. More
  tickets mean a new, separately signed and registered batch. The app does not offer that yet:
  ticket types lock once an event is published.
- **The object names no holder.** Who holds a ticket is the onchain slot owner. A card ticket's
  slot owner is a single-use key created at the sale, which signs that one ticket and is then
  discarded.
- **No personal data.** A ticket body carries its ticket type, number and event details. The
  buyer's details are sealed to the organiser separately (X-Wing) and only a reference goes
  onchain.
- **Anyone can verify.** The manifest is on Swarm, addressed by its hash; the slot owner is a
  free onchain read. A ticket is genuine when its signature recovers to the slot owner.

## Compared with W3C verifiable credentials

| | Verifiable credential | WoCo ticket object |
|---|---|---|
| Signing | The issuer signs each credential | The organiser signs once per batch |
| Supply | The issuer can always issue another | Fixed and registered onchain per batch |
| Holder | Named inside the credential | Not named; the owner is recorded onchain |
| Personal data | Often carried | None; buyer details sealed to the organiser |
| Stack | DIDs and their own proof formats | Ethereum signatures (EIP-191) and addresses |
| Where it lives | Private, in the holder's wallet | Public on Swarm |

What WoCo gives up: verifiable credentials are a W3C standard with wallet support, and WoCo's
formats are open and documented but not a standard. There is no selective disclosure or
zero-knowledge proof. A refund is not recorded onchain (the ledger has no per-slot void), so a
door learns of refunds from the server's pack.

The **certificate rail is credential-shaped**: the issuer signs a claim that names the holder's
key, and the holder proves possession by answering a challenge. It is built and merged, sits
outside launch scope, and has not been run end to end against a real holder.

## Why not "POD"

A POD is a specific format from 0xPARC (EdDSA-Poseidon over Baby Jubjub, used by Zupass and
zero-knowledge proofs). This repo has never used it. The word was used loosely for signed data
and was retired on 2026-09-10: code, wire formats, topics (`woco/object/*`) and UI now say
"object", and `packages/shared/test/no-pod-source.test.ts` fails CI on any reintroduction, so a
real POD integration would arrive into an empty namespace. Older design records still use the
word; [docs/README.md](./README.md) marks them as historical.
