// DEAD — DELETE THIS FILE. Nothing imports it.
//
// It was the at-rest store for the content-feed signer, back when that key was an
// INDEPENDENT secret: established once per account, persisted AES-GCM under the
// device key, escrowed for recovery, and governed by a "stored copy wins" rule so
// a rotated passkey credential could not re-derive a divergent key and orphan the
// user's feeds. The signer is now an HKDF sibling of the identity seed
// (`packages/shared/src/crypto/feed-signer.ts`), so the seed's AAD-bound slot is
// the single durable secret and every one of those properties comes for free.
//
// The storage keys it used are swept on logout by `clearAllAuth` so devices from
// older builds do not keep an orphaned key blob at rest; nothing reads them.
//
// Left as this comment only because the repo's tooling blocks file deletion.
export {};
