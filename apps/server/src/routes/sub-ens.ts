import { Hono } from "hono";
import { isError } from "ethers";
import { requireAuth } from "../middleware/auth.js";
import {
  isLabelAvailable,
  getLabelOwner,
  getOwnedLabels,
  mintSubEnsName,
  relaySignedContenthash,
  getMintAllowance,
  mintRateCapVerdict,
  labelNode,
  relayReleaseWithSignature,
  getSubEnsChainTime,
} from "../lib/chain/sub-ens-contract.js";
import { validateLabel } from "@woco/shared";
import { isProfileName, profileNameOf } from "../lib/profile/name-ledger.js";
import { getApexContenthash } from "../lib/chain/sub-ens-apex.js";
import { stampEventSubEns } from "../lib/event/service.js";
import { checkAttendeeGate } from "../lib/gate/check.js";
import { SlidingWindowLimiter } from "../lib/http/rate-limit.js";
import { clientIp } from "../lib/http/client-ip.js";
import type { AppEnv } from "../types.js";

// Preview links resolve through the WoCo gateway (eth.limo .woco.eth resolution is
// parked until the mainnet resolver cutover — see SUB_ENS_ARBITRUM_PLAN.md).
const PREVIEW_GATEWAY = "https://gateway.woco-net.com";

export const subEnsRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// `validateLabel` (the mirror of WoCoRegistrar._validLabel) now lives in
// @woco/shared so the client prefilter cannot be looser than this one. It stays
// the server-side fast path: a label the registrar could never mint is refused
// without spending a chain read, or the caller's rate budget.

/**
 * `/check` is the only sub-ENS read with no auth and no limit, and every render
 * of a name now goes through it (display verification, plan doc §3 point F). It
 * costs an RPC call, and the display rule is FAIL-CLOSED — so an attacker who
 * can exhaust the RPC quota can make names stop rendering. Sized for a human
 * typing in the claim field plus a page full of cards, not for a scraper.
 */
const checkLimiter = new SlidingWindowLimiter([
  { limit: 60, windowMs: 60_000 },
  { limit: 600, windowMs: 60 * 60_000 },
]);

/** Read the mint allowance, or null when the chain is unreachable — see
 *  `mintRateCapVerdict`, which treats null as "proceed", not "refuse". */
async function readMintAllowance(recipient: string) {
  try {
    return await getMintAllowance(recipient);
  } catch (err) {
    console.warn("[sub-ens] mintAllowance pre-flight unavailable:", err);
    return null;
  }
}

/**
 * Relay budgets. The sponsor pays gas for a burn or a pointer write the HOLDER
 * authorised, so the drain is already bounded by the mint side (to sign you
 * must hold; to hold you must pass the attendee gate and the mint caps). These
 * bound the two things that are not: how much of the names key's nonce queue
 * one account can occupy, and how much of it everyone can occupy at once.
 * Releases and pointer writes are budgeted apart, so binding a few sites never
 * spends the budget a holder needs to discard a name.
 */
function relayLimiters() {
  return {
    account: new SlidingWindowLimiter([
      { limit: 5, windowMs: 60 * 60_000 },
      { limit: 20, windowMs: 24 * 60 * 60_000 },
    ]),
    global: new SlidingWindowLimiter([{ limit: 20, windowMs: 60_000 }]),
  };
}
const releaseLimits = relayLimiters();
const pointerLimits = relayLimiters();
const RELAY_GLOBAL_KEY = "all";

/** Nodes with a relay in flight. Two concurrent posts of ONE signature both
 *  pass simulation; the second would revert on-chain at the sponsor's expense. */
const releasesInFlight = new Set<string>();
const pointersInFlight = new Set<string>();

/** A relayed signature is valid for a window the CLIENT proposes. Bounded both
 *  ways: too short and the tx reverts after the queue delay, at our expense;
 *  too long and the signature is a bearer authorisation sitting in logs and
 *  proxies, which the holder cannot cleanly cancel.
 *
 *  Measured against the CHAIN's clock (`getSubEnsChainTime`), which is the one
 *  the contracts check, not ours: Arbitrum's may run up to a day behind or an
 *  hour ahead of real time (audit 950 Low 13). The client derives its
 *  expiration from the same clock. */
const RELAY_EXPIRY_MIN_SECS = 60;
const RELAY_EXPIRY_MAX_SECS = 15 * 60;

/** Whether `expiration` falls inside the relay's window, measured from
 *  `chainNowSecs`. An integer check first, so a NaN cannot compare false on
 *  both sides and slip through. */
export function relayExpiryInWindow(expiration: number, chainNowSecs: number): boolean {
  if (!Number.isInteger(expiration) || !Number.isInteger(chainNowSecs)) return false;
  const ttl = expiration - chainNowSecs;
  return ttl >= RELAY_EXPIRY_MIN_SECS && ttl <= RELAY_EXPIRY_MAX_SECS;
}

/**
 * The expiration check both relays share: integer, then the chain's clock,
 * then the window. Returns null to proceed, else the refusal. A clock that did
 * not answer is not evidence of anything, so it is its own refusal (the client
 * falls back to the holder's own transaction, which needs no clock) — never a
 * guess from ours.
 */
async function refuseUnlessExpiryInWindow(
  c: { json: (body: unknown, status: number) => Response },
  rawExpiration: unknown,
): Promise<Response | null> {
  const expiration = Number(rawExpiration);
  if (!Number.isInteger(expiration)) {
    return c.json({ ok: false, error: "expiration must be an integer" }, 400);
  }
  let chainNowSecs: number;
  try {
    chainNowSecs = await getSubEnsChainTime();
  } catch (err) {
    console.error("[sub-ens] chain clock read failed:", (err as { shortMessage?: string })?.shortMessage ?? "unspecified");
    return c.json({ ok: false, error: "chain_clock_unverified" }, 502);
  }
  if (!relayExpiryInWindow(expiration, chainNowSecs)) {
    return c.json({ ok: false, error: "expiration_out_of_range" }, 400);
  }
  return null;
}

/**
 * Log a failed relay WITHOUT `err.message`. ethers builds that string by
 * appending every `info` key it was given, and for a CALL_EXCEPTION /
 * INSUFFICIENT_FUNDS / nonce error that includes `transaction={"data":"0x…"}` —
 * the whole calldata, holder signature inside. A names key short of ETH would
 * then park a bearer authorisation in `docker logs` for the life of its expiry.
 * `shortMessage` is the same diagnosis with none of the payload.
 */
function logRelayFailure(what: string, label: string, err: unknown): void {
  const diag = (err as { shortMessage?: string; code?: string }) ?? {};
  console.error(
    `[sub-ens] ${what} failed label=${label} code=${diag.code ?? "none"}:`,
    diag.shortMessage ?? "unspecified error",
  );
}

/**
 * The ownership gate every mutation route shares. Returns null when the caller
 * may proceed; otherwise the refusal to return.
 *
 * Chain ownership is the only authority here, and a read that did not answer is
 * NOT evidence the caller lost the name — so a failed read is its own refusal
 * (502 "unverified"), never the 404/403 that tells a real holder their name is
 * gone or not theirs. Centralised because the three call sites drifted apart on
 * exactly that point, and because there is no Hono `onError` in this server: a
 * throw out of a route becomes a plain-text 500 that the client's `resp.json()`
 * cannot parse.
 *
 * `read` is injected so the refusal ladder is testable without a chain.
 */
export async function refuseUnlessOwner(
  c: { json: (body: unknown, status: number) => Response },
  label: string,
  parentAddress: string,
  read: (label: string) => Promise<string | null> = getLabelOwner,
): Promise<Response | null> {
  let owner: string | null;
  try {
    owner = await read(label);
  } catch (err) {
    console.error("[sub-ens] ownership check failed:", err);
    return c.json({ ok: false, error: "ownership_unverified" }, 502);
  }
  if (!owner) return c.json({ ok: false, error: "label not found" }, 404);
  if (owner !== parentAddress.toLowerCase()) {
    return c.json({ ok: false, error: "not authorised for this label" }, 403);
  }
  return null;
}

/**
 * Is `signature` a hex string of WHOLE BYTES?
 *
 * `0x…` plus an odd number of hex characters is not a byte string, but it
 * satisfies a `[0-9a-fA-F]+` test, so it used to travel all the way into ethers
 * and throw `INVALID_ARGUMENT` inside the relay — answered as a 500. That is the
 * server reporting its own fault for a malformed request, and it hides the one
 * thing the caller needs to be told: fix the field.
 *
 * Length beyond "whole bytes" is deliberately NOT checked. A plain EOA
 * signature is 65 bytes, but `releaseWithSignature` verifies through the
 * ERC-6492 universal validator, so a contract holder's ERC-1271/6492 signature
 * is variable-length (see `release-rails.ts`). Pinning 65 here would refuse
 * every smart-account release the moment those rails switch on.
 */
export function isWholeBytesHex(signature: unknown): signature is string {
  return typeof signature === "string" && /^0x([0-9a-fA-F]{2})+$/.test(signature);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/sub-ens/check/:label
 * Public — no auth. Returns { available: boolean, reason? }.
 */
subEnsRoutes.get("/check/:label", async (c) => {
  const label = c.req.param("label").toLowerCase().trim();

  const validationError = validateLabel(label);
  if (validationError) {
    return c.json({ ok: true, data: { available: false, reason: validationError } });
  }

  // Validation first: a malformed label is answered without a chain read, so it
  // should not spend the caller's budget either.
  const ip = clientIp(c);
  if (!checkLimiter.peek(ip)) {
    return c.json({ ok: false, error: "rate_limited" }, 429);
  }
  checkLimiter.record(ip);

  try {
    const available = await isLabelAvailable(label);
    if (available) return c.json({ ok: true, data: { available: true } });
    // Return the owner so the client can detect "taken by me" and offer re-link.
    const owner = await getLabelOwner(label);
    // A TAKEN name changes hands rarely, so the edge may answer this for a
    // minute. Deliberately not set on the "available" branch: that one is the
    // claim-field typeahead, where a stale "still free" sends a user into a
    // mint that then fails.
    c.header("Cache-Control", "public, max-age=60");
    return c.json({ ok: true, data: { available: false, owner: owner ?? undefined } });
  } catch (err) {
    console.error("[sub-ens] availability check failed:", err);
    return c.json({ ok: false, error: "availability check failed" }, 500);
  }
});

/**
 * GET /api/sub-ens/owned
 * Auth required. Lists every label.woco.eth the authenticated organiser owns,
 * read authoritatively from chain (covers names claimed via any path), so the
 * event + site flows can offer "point an existing name at this". Each entry
 * includes a preview URL when the name currently points at a Swarm site.
 *
 * Response: { names: { label, ensName, contentHash?, previewUrl? }[] }
 */
subEnsRoutes.get("/owned", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  try {
    const owned = await getOwnedLabels(parentAddress);
    const profileName = profileNameOf(parentAddress);
    const names = owned.map(({ label, contentHash }) => ({
      label,
      ensName: `${label}.woco.eth`,
      // Point E: what this name is FOR, so the event and site pickers can hide
      // the identity name instead of offering it and being refused at 409.
      // "url" means it already points somewhere; "free" means it points nowhere
      // yet — both are bindable, the distinction is only for display.
      role: label === profileName ? "profile" : contentHash ? "url" : "free",
      ...(contentHash ? { contentHash, previewUrl: `${PREVIEW_GATEWAY}/bzz/${contentHash}/` } : {}),
    }));
    return c.json({ ok: true, data: { names } });
  } catch (err) {
    console.error("[sub-ens] owned enumeration failed:", err);
    return c.json({ ok: false, error: "could not list owned names" }, 500);
  }
});

/**
 * POST /api/sub-ens/claim
 * Auth required. Mints an EMPTY label.woco.eth to the authenticated account on
 * Arbitrum: the name, its holder and the holder's own address records.
 *
 * Body: { label: string }
 *
 * No contenthash and no text records at mint (registrar v2.2): the sponsor
 * never decides what a name says. Pointing the name at a site or the app is the
 * holder's to sign afterwards (`/set-contenthash`).
 */
subEnsRoutes.post("/claim", requireAuth, async (c) => {
  const parentAddress = c.get("parentAddress");

  // Attendee gate — the rule is lib/gate/check.ts (#575). The error code predates
  // the wider rule; the UI matches on it to open the unlock flow.
  const gate = await checkAttendeeGate(parentAddress as string);
  if (!gate.gated) {
    return c.json({ ok: false, error: "ticket_required" }, 403);
  }

  const body = await c.req.json<{ label?: string }>();

  const label = body.label?.toLowerCase()?.trim();
  if (!label) return c.json({ ok: false, error: "label is required" }, 400);

  const validationError = validateLabel(label);
  if (validationError) return c.json({ ok: false, error: validationError }, 400);

  // Pre-flight availability check for a clean user-facing error (contract also guards this)
  try {
    const available = await isLabelAvailable(label);
    if (!available) return c.json({ ok: false, error: "label already taken" }, 409);
  } catch (err) {
    console.error("[sub-ens] pre-flight check failed:", err);
    return c.json({ ok: false, error: "availability check failed" }, 500);
  }

  const capped = mintRateCapVerdict(await readMintAllowance(parentAddress as string));
  if (capped) return c.json({ ok: false, ...capped }, 429);

  try {
    const txHash = await mintSubEnsName(label, parentAddress);
    return c.json({
      ok: true,
      data: { label, ensName: `${label}.woco.eth`, txHash },
    });
  } catch (err: unknown) {
    // Decode ethers v6 custom errors (requires error defs in REGISTRAR_ABI)
    if (isError(err, "CALL_EXCEPTION")) {
      const revert = (err as { revert?: { name?: string; args?: unknown[] } }).revert;
      const name = revert?.name;
      if (name === "LabelIsReserved")     return c.json({ ok: false, error: "label is reserved" }, 409);
      if (name === "InvalidLabel")        return c.json({ ok: false, error: "invalid label" }, 400);
      if (name === "NotAuthorisedSponsor") {
        console.error("[sub-ens] names sponsor key not authorised on registrar");
        return c.json({ ok: false, error: "name registration temporarily unavailable" }, 503);
      }
      // The registry refused the registrar itself: not enrolled — after an
      // admin handover that did not re-enrol it (registry v2.2).
      if (name === "Unauthorized") {
        console.error("[sub-ens] registrar not enrolled in the registry");
        return c.json({ ok: false, error: "name registration temporarily unavailable" }, 503);
      }
      // #464 per-recipient cap. Reachable despite the pre-flight above: the
      // read can race a concurrent mint, and it is skipped when the RPC is
      // unavailable. Report the window rather than a generic failure (#471).
      if (name === "MintRateCapExceeded") {
        const windowResetsAt = Number(revert?.args?.[1] ?? 0);
        return c.json({ ok: false, error: "mint_rate_cap", data: { windowResetsAt } }, 429);
      }
      // The registrar-wide cap: names are busy for EVERYONE, not this caller,
      // so 503 rather than 429 and the client says "try again at HH:MM". It is
      // also the leaked-key detector, which /api/health watches.
      if (name === "GlobalMintCapExceeded") {
        const windowResetsAt = Number(revert?.args?.[0] ?? 0);
        console.warn(`[sub-ens] registrar-wide mint cap reached until ${windowResetsAt}`);
        return c.json({ ok: false, error: "mint_global_cap", data: { windowResetsAt } }, 503);
      }
    }
    // Race condition: another request registered the label between our check and the tx
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("NotAvailable")) return c.json({ ok: false, error: "label already taken" }, 409);

    console.error("[sub-ens] claim failed:", err);
    return c.json({ ok: false, error: "claim failed" }, 500);
  }
});

/**
 * POST /api/sub-ens/stamp-event
 * Auth required. Records label.woco.eth on an event feed as a display hint,
 * after verifying ON-CHAIN that the authenticated organiser owns the label.
 * One endpoint covers every claim path (mint, repoint) — the client calls it
 * once its claim/repoint has succeeded.
 *
 * Body: { label: string, eventId: string }
 */
subEnsRoutes.post("/stamp-event", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const body = await c.req.json<{ label?: string; eventId?: string }>();

  const label = body.label?.toLowerCase()?.trim() ?? "";
  const eventId = body.eventId?.trim() ?? "";
  if (!label) return c.json({ ok: false, error: "label is required" }, 400);
  if (!eventId) return c.json({ ok: false, error: "eventId is required" }, 400);
  const validationError = validateLabel(label);
  if (validationError) return c.json({ ok: false, error: validationError }, 400);

  // Same IDOR guard as set-contenthash: chain ownership is the authority.
  const refused = await refuseUnlessOwner(c, label, parentAddress);
  if (refused) return refused;
  // Point A: the caller's own identity name is not a URL to hand to an event.
  if (isProfileName(parentAddress, label)) {
    return c.json({ ok: false, error: "profile_name" }, 409);
  }

  try {
    const updated = await stampEventSubEns(eventId, label, parentAddress);
    // Phase B: for a client-owned feed the server skipped the write — hand the
    // updated feed back so the client re-signs its SOC with the label. Legacy
    // events were already platform-written; eventFeed is harmless there.
    return c.json({ ok: true, data: { label, eventId, ...(updated.creatorFeedSigner ? { eventFeed: updated } : {}) } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "stamp failed";
    const status = msg === "Event not found" ? 404 : msg === "Not the event creator" ? 403 : 500;
    if (status === 500) console.error("[sub-ens] stamp-event failed:", err);
    return c.json({ ok: false, error: msg }, status);
  }
});

/**
 * POST /api/sub-ens/set-contenthash
 * Auth required. Relays a pointer write the HOLDER signed, paying the gas.
 *
 * Body: { label, swarmHash, expiration, signature }
 *
 * The signature is the authority: `WoCoRegistrar.setContenthashWithSignature`
 * checks it against the name's current holder (EIP-712 `SetContenthash`, a
 * per-name nonce, the chain's clock), so the names key can only relay what the
 * holder signed — never repoint a name on its own. Refusing to relay traps
 * nobody: a holder can always write its own record at the registry.
 *
 * The ownership and profile-name checks below are GAS POLICY and accident
 * guards, not the security boundary.
 */
subEnsRoutes.post("/set-contenthash", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const body = await c.req.json<{ label?: string; swarmHash?: string; expiration?: number; signature?: string }>();

  const label = body.label?.toLowerCase()?.trim() ?? "";
  if (!label) return c.json({ ok: false, error: "label is required" }, 400);
  const validationError = validateLabel(label);
  if (validationError) return c.json({ ok: false, error: validationError }, 400);

  const swarmHash = (body.swarmHash ?? "").replace(/^0x/, "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(swarmHash)) {
    return c.json({ ok: false, error: "swarmHash must be a 64-char hex string" }, 400);
  }

  const signature = typeof body.signature === "string" ? body.signature : "";
  if (!signature) return c.json({ ok: false, error: "signature is required" }, 400);
  if (!isWholeBytesHex(signature)) {
    return c.json({ ok: false, error: "signature must be hex of whole bytes" }, 400);
  }

  const expiryRefused = await refuseUnlessExpiryInWindow(c, body.expiration);
  if (expiryRefused) return expiryRefused;
  const expiration = Number(body.expiration);

  // Gas policy: the sponsor pays only for the caller's own name.
  const refused = await refuseUnlessOwner(c, label, parentAddress);
  if (refused) return refused;

  // Point C: the identity name points at the app and nowhere else. A site
  // pointer on it would make the organiser's identity a URL for one site.
  if (isProfileName(parentAddress, label) && swarmHash !== getApexContenthash()) {
    return c.json({ ok: false, error: "profile_name" }, 409);
  }

  if (!pointerLimits.account.peek(parentAddress) || !pointerLimits.global.peek(RELAY_GLOBAL_KEY)) {
    return c.json({ ok: false, error: "rate_limited" }, 429);
  }

  const node = labelNode(label);
  if (pointersInFlight.has(node)) {
    return c.json({ ok: false, error: "pointer_in_flight" }, 409);
  }

  // Both budgets are peeked before either is charged, so a request refused on
  // the global limit is not charged against the caller's own.
  pointerLimits.account.record(parentAddress);
  pointerLimits.global.record(RELAY_GLOBAL_KEY);
  pointersInFlight.add(node);
  try {
    const txHash = await relaySignedContenthash(label, swarmHash, expiration, signature);
    return c.json({ ok: true, data: { label, txHash } });
  } catch (err: unknown) {
    if (isError(err, "CALL_EXCEPTION")) {
      const name = (err as { revert?: { name?: string } }).revert?.name;
      // Named refusals, so the client can say what happened rather than "failed".
      if (name === "NotHolderSignature") return c.json({ ok: false, error: "signature_not_authorised" }, 403);
      if (name === "SignatureExpired")   return c.json({ ok: false, error: "signature_expired" }, 400);
      if (name === "ExpirationTooFar")   return c.json({ ok: false, error: "expiration_too_far" }, 400);
      if (name === "EmptyContenthash")   return c.json({ ok: false, error: "swarmHash is empty" }, 400);
      if (name === "InvalidLabel")       return c.json({ ok: false, error: "invalid label" }, 400);
      if (name === "LabelNotRegistered") return c.json({ ok: false, error: "label not found" }, 404);
      if (name === "LabelIsReserved")    return c.json({ ok: false, error: "label is reserved" }, 409);
      // The holder check passed, so the registry refusing the write means the
      // registrar is not enrolled (registry v2.2, after an admin handover).
      if (name === "Unauthorized") {
        console.error("[sub-ens] registrar not enrolled in the registry");
        return c.json({ ok: false, error: "update temporarily unavailable" }, 503);
      }
    }
    logRelayFailure("set-contenthash relay", label, err);
    return c.json({ ok: false, error: "update failed" }, 500);
  } finally {
    pointersInFlight.delete(node);
  }
});

/**
 * POST /api/sub-ens/relay-release
 * Auth required. Submits a release the HOLDER signed, paying the gas.
 *
 * Body: { label, expiration, signature }
 *
 * The signature is the authority: `L2Registry.releaseWithSignature` checks that
 * `signer` is the holder BEFORE it consults the signature, so the sponsor can
 * only ever relay what the holder authorised — never forge one. Refusing to
 * relay traps nobody either: a holder can always submit `release` from their
 * own wallet.
 *
 * `signer` and `node` are derived server-side from the VERIFIED parent address
 * and the VALIDATED label. Neither is a body field — a body-supplied node would
 * aim the signature at a name the ownership check never saw.
 *
 * The on-chain check accepts the holder's signature only (registry v2.1); this
 * route also refuses anyone but the holder before simulating, so the sponsor
 * spends nothing on a signature the chain would refuse. That check is a GAS
 * POLICY, not the security boundary.
 */
subEnsRoutes.post("/relay-release", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const body = await c.req.json<{ label?: string; expiration?: number; signature?: string }>();

  const label = body.label?.toLowerCase()?.trim() ?? "";
  if (!label) return c.json({ ok: false, error: "label is required" }, 400);
  const validationError = validateLabel(label);
  if (validationError) return c.json({ ok: false, error: validationError }, 400);

  const signature = typeof body.signature === "string" ? body.signature : "";
  if (!signature) return c.json({ ok: false, error: "signature is required" }, 400);
  if (!isWholeBytesHex(signature)) {
    return c.json({ ok: false, error: "signature must be hex of whole bytes" }, 400);
  }

  const expiryRefused = await refuseUnlessExpiryInWindow(c, body.expiration);
  if (expiryRefused) return expiryRefused;
  const expiration = Number(body.expiration);

  // Gas policy: the sponsor pays only for the caller's own name.
  const refused = await refuseUnlessOwner(c, label, parentAddress);
  if (refused) return refused;

  // Accident guard, not a security one: releasing the name you are currently
  // known by is a one-click route to being nameless for the whole cooldown.
  // The holder can still burn it from their own wallet — we simply do not
  // sponsor it, which keeps "release is ungated" true on-chain.
  if (isProfileName(parentAddress, label)) {
    return c.json({ ok: false, error: "profile_name" }, 409);
  }

  if (!releaseLimits.account.peek(parentAddress) || !releaseLimits.global.peek(RELAY_GLOBAL_KEY)) {
    return c.json({ ok: false, error: "rate_limited" }, 429);
  }

  const node = labelNode(label);
  if (releasesInFlight.has(node)) {
    return c.json({ ok: false, error: "release_in_flight" }, 409);
  }

  // Both budgets are peeked before either is charged, so a request refused on
  // the global limit is not charged against the caller's own.
  releaseLimits.account.record(parentAddress);
  releaseLimits.global.record(RELAY_GLOBAL_KEY);
  releasesInFlight.add(node);
  try {
    const { txHash } = await relayReleaseWithSignature(node, expiration, parentAddress, signature);
    return c.json({ ok: true, data: { label, txHash } });
  } catch (err: unknown) {
    if (isError(err, "CALL_EXCEPTION")) {
      const name = (err as { revert?: { name?: string } }).revert?.name;
      // Named refusals, so the client can say what happened rather than "failed".
      if (name === "Unauthorized")        return c.json({ ok: false, error: "signature_not_authorised" }, 403);
      if (name === "SignatureExpired")    return c.json({ ok: false, error: "signature_expired" }, 400);
      if (name === "ReleaseUnregistered") return c.json({ ok: false, error: "label not found" }, 404);
      if (name === "ReleaseBaseNode")     return c.json({ ok: false, error: "cannot release the base name" }, 400);
      // Registry v2.1. A name with names beneath it waits for them: the client
      // shows this rather than falling back, because every rail would meet it.
      if (name === "HasChildren")         return c.json({ ok: false, error: "has_children" }, 409);
      // The block clock trails ours by nearly two days. The client's own-gas
      // fallback needs no signature, so it still works.
      if (name === "ExpirationTooFar")    return c.json({ ok: false, error: "expiration_too_far" }, 400);
    }
    logRelayFailure("relay-release", label, err);
    return c.json({ ok: false, error: "release failed" }, 500);
  } finally {
    releasesInFlight.delete(node);
  }
});
