# The passkey sign-in window

Every WoCo passkey ceremony - sign-up, sign-in, the organiser unlock, an added passkey, a backup
passkey, recovery, the upgrade from email - runs in one small page on **`auth.woco.eth.limo`**, opened
from the app at `woco.eth.limo` (a pop-up on a desktop, a tab on a phone). The app never calls WebAuthn
and never holds the PRF output: the window derives the account's keys from it and hands over only those.

Decided 2026-10-21 (Fable design consult, owner go). Code: `apps/web/src/auth-window/` (the window),
`apps/web/src/lib/auth/passkey-window.ts` (the app's side), `packages/shared/src/auth/passkey-window-protocol.ts`
(the messages), `packages/shared/src/crypto/passkey-prf.ts` (what crosses).

## Why a separate host

- **The RP ID.** `*.eth.limo` joined the Public Suffix List on 2026-09-01, so `woco.eth.limo` is itself a
  public suffix: Firefox refuses it as an RP ID, and a browser with an older list let any holder-run
  `<name>.woco.eth.limo` page ask for the WoCo passkey. `auth.woco.eth.limo` is one label below the suffix
  (every engine accepts it) and a sibling of every sub-name (none can claim it, in any browser).
- **Custody.** `auth.woco.eth` is an L1 subnode with its own Public Resolver - never our CCIP gateway - and
  its contenthash is an IMMUTABLE Swarm reference the owner's Safe sets. Changing the page that holds every
  passkey account is a Safe transaction, not a deploy.
- **Framing is not an option.** eth.limo sends `X-Frame-Options: SAMEORIGIN`, and WebKit refuses `create()`
  in a cross-origin frame, so a top-level window is the only transport.

## What the window guarantees

Account keys leave the window only (i) to the window that opened it, captured once at load, (ii) whose
origin is exactly `https://woco.eth.limo`, (iii) by `postMessage` to that literal origin, (iv) once, (v)
after a tap in the window, (vi) from a page running only on `https://auth.woco.eth.limo`, unframed, under a
hash CSP (`default-src 'none'`, `connect-src 'none'`, `webrtc 'block'`), with no storage, network, URL data or other channel;
(vii) the raw PRF output never leaves at all. `test/auth-window-artifact.test.ts` builds the real file and
runs it in a sandbox against these.

What crosses, per answer (`PasskeyAccountKeys`): the owner key `keccak256(prf)`, the seed of an account
this passkey made, the seed lock, the box seed (#186), the portability SOC key and HPKE seed - private keys
only; the app computes addresses and the X-Wing keypair. A backup passkey answers with its guardian owner
key and escrow master only. Sign-in and unlock get the same set: the only requester is the app, which
receives the seed lock (and so the seed) either way.

## Frozen, sticky, changeable

- **Frozen from launch:** the RP ID, `PASSKEY_PRF_SALT_INPUT`, every label in `passkey-prf.ts`, owner key =
  `keccak256(prf)`, "the PRF output never leaves the window", and the rule that a non-WoCo origin will only
  ever receive keys whose HKDF info names that origin.
- **Sticky:** the user-handle prefixes, the protocol version `v`.
- **Changeable by Safe transaction:** the window's copy, the opener allowlist, the per-action key sets.

## Building, uploading, pinning

`npm run build:auth` builds `apps/web/dist-auth/` (`index.html` + a scriptless `404.html` as the error
document). The build fails unless the page names exactly its production settings, uses none of the denied
channels, and its CSP pins its own bytes. `node scripts/upload-auth-window.cjs` re-checks the same rules,
uploads the two files as a collection (no feed) and prints the reference and its ENS contenthash. A new
reference means a Safe transaction on `auth.woco.eth`; the same bytes on a new postage batch give the same
reference, so re-run it after every batch swap, as for the scanner.

## Local development

`npm run dev:auth` builds the dev window (`--mode dev-window`, into `dist-auth-dev/`) and serves it on
`http://localhost:5174` for the app's dev server on `http://localhost:5173`: two origins, as in production,
so dev runs the real window under its CSP. The dev settings come from the Vite mode, never from `.env`, and
the app's window origin is a literal per build, never a setting.

## Opening it from a tap

Browsers open a window only inside the click that asked (Safari is strictest). A button that is certain to
need a ceremony calls `primePasskeyWindow()` as its first statement (the sign-in and create buttons do);
anything else reached a ceremony from deep async code, and gets the "Continue with your passkey" sheet,
whose button opens the window. The window waits for its own Continue tap before any prompt.

## The home-screen app

From WoCo installed to a home screen, a window it opens may live outside the app with no way back to it
(iOS opens other origins in its own sheet; Fable sign-off 2026-10-21, unmeasured). The app does not guess
up front: when the window never says ready there, it says passkeys open in the browser instead. Measure on
an installed iPhone app before relying on either outcome.

## Not done yet (after launch)

The pinned-bytes half of the health probe (the header half is live: `/api/health` `signInWindow`), an expiry
alarm for `auth.woco.eth`, the desktop "no passkey store here" wording and WebAuthn `hints`, priming the
organiser buttons (one tap fewer), integrity pinning of the app's own scripts, a redirect fallback if
eth.limo ever sends a Cross-Origin-Opener-Policy.
