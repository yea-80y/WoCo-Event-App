<script lang="ts">
  import type { Hex0x } from "@woco/shared";
  import { getSocialState, toggleSocial, kindForVariant, lastKnownCount } from "../../api/social.js";
  import { auth } from "../../auth/auth-store.svelte.js";

  interface Props {
    subject: Hex0x;
    /**
     * "heart" (default) = like a happening (event onChainEventId): heart + count.
     * "follow" = follow an ACCOUNT (its address as bytes32): "Follow"/"Following".
     * Both write a signed statement to the user's own Swarm feed; the variant
     * selects the statement KIND (woco.like.v1 / woco.follow.v1), which are
     * separate topics, so a like and a follow of one subject never collide.
     */
    variant?: "heart" | "follow";
    /** Names WHAT is being liked (e.g. "event") — shown as a muted mono caption
     *  so the target is unambiguous when hearts and follows share a page. */
    caption?: string;
    /** Count-only view (e.g. your own follower count) — no action, no toggle. */
    readonly?: boolean;
  }

  let { subject, variant = "heart", caption, readonly = false }: Props = $props();

  // null = nobody has counted yet (no indexer), which renders as ABSENT. Zero
  // would be a claim that nobody liked it — a different, and wrong, statement.
  //
  // Seeded from the last count this browser saw for THIS subject, so a returning
  // reader gets the number at first paint instead of a dot, and keeps it if the
  // indexer is unreachable. Own state (`liked`) is never seeded — it belongs to
  // whoever is signed in now, which a previous visit cannot know.
  //
  // The init-capture is the point: this is the value to paint BEFORE the effect
  // runs, and a later subject re-seeds it inside the effect below. A $derived
  // would fight every reconcile, since the live count must overwrite the
  // remembered one.
  // svelte-ignore state_referenced_locally
  let count = $state<number | null>(lastKnownCount(kindForVariant(variant), subject));
  let liked = $state(false);
  let inFlight = $state(false);
  let loaded = $state(false);
  let errMsg = $state<string | null>(null);
  let errTimer: ReturnType<typeof setTimeout> | undefined;

  // Monotonic token: any state-setting fetch must still hold the latest token
  // when it resolves. Guards against the login-popup race — completing sign-in
  // mid-click changes auth.parent, which re-runs the $effect; without the token
  // its stale response would clobber the optimistic toggle state.
  let fetchToken = 0;

  // Only show the loading dot for a subject we haven't displayed yet — silent
  // refresh otherwise (post-toggle reconcile, login state change).
  let lastLoadedId: string | null = null;

  // Set when a toggle lands, to skip exactly one post-settle refetch. Without
  // it, a freshly written statement that the gateway has not finished
  // whitelisting reads back stale, and the button silently flips back despite
  // the write having succeeded. A plain `let`, not $state — reading it must not
  // make the effect depend on it.
  let skipRefetchFor: string | null = null;

  $effect(() => {
    // Read auth so the effect re-runs on sign-in: own state is unreadable until
    // there is an account whose feed to read it from.
    void auth.parent;
    const id = subject;
    if (inFlight) return; // re-runs when the toggle settles (inFlight is a dep)
    if (skipRefetchFor === id) {
      skipRefetchFor = null;
      return;
    }
    const token = ++fetchToken;
    if (lastLoadedId !== id) {
      loaded = false;
      // A different subject's number must never sit under this subject's heart,
      // so the displayed count is replaced by THIS subject's last-known one —
      // or by nothing, if this browser has never seen it.
      count = lastKnownCount(kindForVariant(variant), subject);
    }
    getSocialState(kindForVariant(variant), subject).then((res) => {
      if (token !== fetchToken) return;
      // An unreachable indexer leaves the last-known number standing rather than
      // blanking it: the reader loses freshness, not the figure. Only a count
      // that actually arrived can replace one.
      count = res.count ?? count;
      liked = res.liked;
      lastLoadedId = id;
      loaded = true;
    });
  });

  function friendlyError(err: unknown): string {
    const m = err instanceof Error ? err.message : String(err);
    if (/reject|denied|cancel/i.test(m)) return "Cancelled";
    // Both are "try again" for genuinely different reasons, and both are real:
    // another device won the same feed version, or the version probe could not
    // reach a conclusion and the write correctly refused rather than guessing.
    if (/another device|inconclusive/i.test(m)) return "Try again";
    if (/sign in/i.test(m)) return m; // already phrased for a person
    return "Not saved — tap to retry";
  }

  function showError(err: unknown) {
    console.error("[LikeButton]", err);
    errMsg = friendlyError(err);
    clearTimeout(errTimer);
    errTimer = setTimeout(() => { errMsg = null; }, 5000);
  }

  async function handleClick(e: MouseEvent) {
    // Stop the click bubbling — this button often lives inside a clickable
    // event card; a like/follow must not also open the card.
    e.stopPropagation();
    if (readonly || inFlight || !loaded) return;
    inFlight = true;
    errMsg = null;
    fetchToken++; // invalidate any read still in the air

    // WHICH subject this click is about, captured before any await. `subject` is
    // a prop: a parent that swaps it while the write is in flight changes what
    // `subject.id` reads afterwards, and stamping the skip with the NEW id would
    // suppress the new subject's only fetch — leaving it displaying the old
    // subject's state, marked loaded, until some other dependency moved.
    const togglingFor = subject;

    const prevLiked = liked;
    const prevCount = count;
    liked = !prevLiked;
    // An unknown count stays unknown — nudging null to 1 would invent a tally
    // out of the viewer's own action.
    if (prevCount !== null) count = prevLiked ? Math.max(0, prevCount - 1) : prevCount + 1;

    try {
      const r = await toggleSocial(kindForVariant(variant), subject, prevLiked);
      if (r === null) {
        // User dismissed the sign-in popup — quiet revert, not an error.
        liked = prevLiked;
        count = prevCount;
      } else {
        liked = r.liked;
        // Keep the OPTIMISTIC count when the write path has no fresh number —
        // falling back to prevCount would undo the ±1 we just applied and show
        // the pre-toggle figure beside a toggled heart.
        count = r.count ?? count;
        skipRefetchFor = togglingFor;
      }
    } catch (err) {
      liked = prevLiked;
      count = prevCount;
      showError(err);
    } finally {
      inFlight = false;
    }
  }
</script>

{#if variant === "follow" && readonly}
  <!-- Self-view: the count is public information; the action isn't yours to take. -->
  <span class="follow-stat" title="Followers">
    <svg class="follow-ico" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8" r="3.6" fill="none" stroke="currentColor" stroke-width="2"/>
      <path d="M5 19.5c1.4-3.1 4-4.7 7-4.7s5.6 1.6 7 4.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>
    {#if count === null}·{:else}{count}{/if}
    <span class="stat-label">{count === 1 ? "follower" : "followers"}</span>
  </span>
{:else if variant === "follow"}
  <button
    class="follow-btn"
    class:following={liked}
    class:loading={!loaded}
    class:failed={!!errMsg}
    onclick={handleClick}
    disabled={inFlight}
    aria-label={liked ? "Unfollow" : "Follow"}
    title={liked ? "Unfollow" : "Follow"}
  >
    {#if liked}
      <svg class="follow-ico" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    {:else}
      <svg class="follow-ico" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
      </svg>
    {/if}
    <span class="follow-label">
      {#if !loaded}·{:else}{liked ? "Following" : "Follow"}{/if}
    </span>
    <!-- The count is public and may be remembered; the LABEL beside it is the
         viewer's own state and waits for a real read. -->
    {#if count !== null && count > 0}<span class="follow-count">{count}</span>{/if}
  </button>
  {#if errMsg}<span class="like-err" role="status">{errMsg}</span>{/if}
{:else}
  <button
    class="like-btn"
    class:liked
    class:loading={!loaded}
    class:failed={!!errMsg}
    onclick={handleClick}
    disabled={inFlight}
    aria-label={liked ? "Unlike" : "Like"}
    title={liked ? "Unlike" : "Like"}
  >
    <svg class="heart" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 21L3.5 12.5C1.5 10.5 1.5 7.2 3.5 5.2C5.5 3.2 8.8 3.2 10.8 5.2L12 6.4L13.2 5.2C15.2 3.2 18.5 3.2 20.5 5.2C22.5 7.2 22.5 10.5 20.5 12.5L12 21Z"
        fill={liked ? "currentColor" : "none"}
        stroke="currentColor"
        stroke-width={liked ? "0" : "1.8"}
        stroke-linejoin="round"
      />
    </svg>
    <span class="count" class:zero={count === null || (count === 0 && !liked)}>
      {#if count !== null && count > 0}{count}{:else if !loaded}·{/if}
    </span>
    {#if caption}<span class="caption">{caption}</span>{/if}
  </button>
  {#if errMsg}<span class="like-err" role="status">{errMsg}</span>{/if}
{/if}

<style>
  .like-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    padding: 0.3125rem 0.5625rem 0.3125rem 0.4375rem;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    font-family: var(--font-mono, "SF Mono", "Fira Code", monospace);
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    line-height: 1;
    transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
    white-space: nowrap;
  }

  .like-btn.loading { opacity: 0.5; cursor: default; }

  .like-btn:hover:not(:disabled):not(.loading) {
    color: var(--accent);
    border-color: var(--accent-subtle);
    background: var(--accent-subtle);
  }

  .like-btn.liked { color: var(--accent); }

  .like-btn.liked:hover:not(:disabled) {
    color: var(--accent-hover);
    border-color: var(--accent-subtle);
    background: var(--accent-subtle);
  }

  .like-btn:disabled { cursor: default; }

  .heart {
    flex-shrink: 0;
    transition: transform 0.12s ease;
  }

  .like-btn:not(:disabled):active .heart { transform: scale(0.82); }

  .count { min-width: 0.625rem; }
  .count.zero { opacity: 0; }

  /* ── Failure micro-state: shake + transient mono chip ─────────── */
  .like-btn.failed, .follow-btn.failed {
    animation: like-shake 0.34s cubic-bezier(0.36, 0.07, 0.19, 0.97);
  }

  .like-err {
    display: inline-block;
    margin-left: 0.375rem;
    padding: 0.1875rem 0.4375rem;
    font-family: var(--font-mono, "SF Mono", "Fira Code", monospace);
    font-size: 0.625rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    line-height: 1.3;
    color: var(--error, #ef4444);
    background: color-mix(in srgb, var(--error, #ef4444) 9%, transparent);
    border: 1px solid color-mix(in srgb, var(--error, #ef4444) 28%, transparent);
    border-radius: var(--radius-sm);
    white-space: nowrap;
    animation: like-err-in 0.18s ease-out;
  }

  @keyframes like-shake {
    10%, 90% { transform: translateX(-1px); }
    30%, 70% { transform: translateX(2px); }
    50% { transform: translateX(-2px); }
  }

  @keyframes like-err-in {
    from { opacity: 0; transform: translateX(-3px); }
    to { opacity: 1; transform: translateX(0); }
  }

  /* ── Follow variant: name-follow pill ─────────────────────── */
  .follow-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    padding: 0.25rem 0.625rem 0.25rem 0.5rem;
    border: 1px solid var(--accent-subtle);
    border-radius: var(--radius-sm);
    background: none;
    color: var(--accent);
    cursor: pointer;
    font-family: var(--font-mono, "SF Mono", "Fira Code", monospace);
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    line-height: 1;
    transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
    white-space: nowrap;
  }

  .follow-btn.loading { opacity: 0.5; cursor: default; }

  .follow-btn:hover:not(:disabled):not(.loading) {
    background: var(--accent-subtle);
    border-color: var(--accent);
  }

  /* Following = filled/confirmed; reverts to outline-danger affordance on hover */
  .follow-btn.following {
    color: var(--accent-text);
    background: var(--accent-subtle);
    border-color: var(--accent-subtle);
  }

  .follow-btn:disabled { cursor: default; }

  .follow-ico { flex-shrink: 0; }

  .follow-count {
    padding-left: 0.3125rem;
    margin-left: 0.0625rem;
    border-left: 1px solid var(--accent-subtle);
    color: var(--text-muted);
    font-weight: 500;
  }

  /* Heart caption — names the like target ("event") in muted mono */
  .caption {
    color: var(--text-muted);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.5625rem;
    opacity: 0.8;
  }

  /* Read-only follower stat (self-view) — same plate language, no affordance */
  .follow-stat {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    padding: 0.25rem 0.625rem 0.25rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-family: var(--font-mono, "SF Mono", "Fira Code", monospace);
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    line-height: 1;
    white-space: nowrap;
  }

  .stat-label {
    color: var(--text-muted);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.5625rem;
  }
</style>
