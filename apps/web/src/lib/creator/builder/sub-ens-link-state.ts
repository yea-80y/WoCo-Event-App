/**
 * When may the picker offer "Open ↗" for a `label.woco.eth` address?
 *
 * eth.limo mints the TLS certificate for a subname on the FIRST request, and
 * only if the name already resolves to a contenthash. A click before that
 * happens does two bad things at once: the visitor gets a TLS error page for an
 * address the UI just told them is theirs, and the failed ask is spent from a
 * budget of roughly ten asks per fifteen minutes PER HOSTNAME, with the negative
 * answer cached for five minutes. So the wrong click does not just fail — it
 * delays the moment the right click could have worked.
 *
 * Hence: the link is offered only on evidence that the name resolves, and that
 * evidence is a chain read (`GET /api/sub-ens/owned` → `contentHash`), never the
 * local fact that a name was claimed or a deploy was started. Everything else
 * here is about saying WHY the link is missing, so the absence reads as a state
 * and not as a bug.
 *
 * Pure on purpose: the component around it is a runes module the node test
 * runner cannot load, and this is the part with rules worth pinning.
 */

/** Gap between chain re-reads while a deploy's contenthash is still landing. */
export const SUB_ENS_POLL_INTERVAL_MS = 5000;

/**
 * How long a publish takes to show at a name that already points at the site.
 * The publish is one feed-update chunk written to Etherna, and the name serves it
 * only once that chunk has spread to the node behind it: measured 4.5 min
 * (2026-09-21) and 5.5 min (2026-09-22), #613. The files are not the wait.
 */
export const NAME_SHOWS_PUBLISH_AFTER = "about 5 minutes";

/**
 * Re-reads before the picker stops asking. 24 × 5s = two minutes, which covers
 * an Arbitrum write plus a comfortable margin. The bound exists because the
 * pointer write needs the HOLDER's signature (v2.2, #599): if they never sign,
 * or the relay refuses it, there is nothing to wait for, and an unbounded poll
 * would hammer an authenticated chain-scanning endpoint forever on an open tab.
 */
export const SUB_ENS_POLL_MAX_ATTEMPTS = 24;

/**
 * Why the Open link is absent, or — for `stale-version` — why it may open
 * something older than the last publish. `null` means nothing needs saying.
 */
export type SubEnsLinkNote =
  | "identity"
  | "registering"
  | "updating"
  | "stale-version"
  | "gave-up"
  | null;

export interface SubEnsLinkInput {
  /** The picker holds a label for this account. */
  claimed: boolean;
  /** Profile mode: this is the account's identity name, not a site address. */
  singleName: boolean;
  /** 64-hex Swarm hash the name resolves to on chain, from `/api/sub-ens/owned`. */
  contentHash: string | null | undefined;
  /**
   * 64-hex Swarm hash the name SHOULD resolve to; '' when never deployed. For a
   * site that is its FEED manifest, not the content: the name follows every
   * publish through the feed, so a republish never changes what it points at.
   */
  targetHash: string;
  /** Chain reads already spent on this label since the deploy. */
  attempts: number;
}

export interface SubEnsLinkState {
  showOpen: boolean;
  note: SubEnsLinkNote;
  pollAgain: boolean;
}

/**
 * Both sides must be the SAME quantity: what the chain record holds
 * (`decodeSwarmContenthash` in the owned-names read) and what the caller says
 * it should hold. A site passing its CONTENT hash here never matched after
 * v2.2 pointed names at the feed, so every publish read as "still updating".
 *
 * Compared case-insensitively and without an `0x`: the encoder accepts either
 * case and the decoder lower-cases, so a difference in spelling would otherwise
 * read as a difference in content and poll for two minutes over nothing.
 */
function sameHash(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (h: string | null | undefined) => (h ?? "").replace(/^0x/i, "").toLowerCase();
  return norm(a) === norm(b);
}

export function subEnsLinkState(input: SubEnsLinkInput): SubEnsLinkState {
  const { claimed, singleName, contentHash, targetHash, attempts } = input;

  // Nothing claimed: there is no address to open and nothing to explain.
  if (!claimed) return { showOpen: false, note: null, pollAgain: false };

  // THE RULE. A contenthash is the only evidence eth.limo can issue a
  // certificate; without one the link is a guaranteed TLS error and a spent ask.
  const showOpen = !!contentHash;

  let note: SubEnsLinkNote = null;
  if (singleName && !contentHash) {
    // The identity name is deliberately never pointed at a site (the deploy hook
    // refuses it with 409 `profile_name`), so "not yet" would be a lie — it is
    // never going to open, and saying so stops the user hunting for the link.
    note = "identity";
  } else if (!contentHash && !targetHash) {
    // Claimed but never published. The name exists on chain and can receive
    // payments; it has no content to serve, and no deploy is pending.
    note = "registering";
  } else if (!contentHash && targetHash && attempts < SUB_ENS_POLL_MAX_ATTEMPTS) {
    // A deploy went out and the pointer write has not landed yet (the holder
    // signs it after the deploy answers).
    note = "updating";
  } else if (!contentHash && targetHash) {
    // Past the bound. Do not promise a link that has not arrived in two minutes
    // and do not keep asking: send the user away and let them come back.
    note = "gave-up";
  } else if (contentHash && targetHash && !sameHash(contentHash, targetHash)) {
    // The name resolves, so the certificate exists and the link is safe — it
    // just serves something else until the new pointer lands. Saying so stops
    // "I published and the site is unchanged" reading as a lost deploy.
    note = "stale-version";
  }

  // Only a deploy creates something to wait for, and only until the name agrees
  // with it. Each read is an authenticated chain scan, so it is bounded both by
  // the target being reached and by the attempt ceiling.
  const pollAgain =
    !!targetHash && attempts < SUB_ENS_POLL_MAX_ATTEMPTS && !sameHash(contentHash, targetHash);

  return { showOpen, note, pollAgain };
}
