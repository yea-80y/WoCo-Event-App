<script lang="ts">
  import type { LikeSubject, Hex0x } from "@woco/shared";
  import { getLikeCount, toggleLike } from "../../api/likes.js";
  import { auth } from "../../auth/auth-store.svelte.js";

  interface Props {
    subject: LikeSubject;
  }

  let { subject }: Props = $props();

  let count = $state(0);
  let liked = $state(false);
  let viewerUid = $state<Hex0x | undefined>(undefined);
  let inFlight = $state(false);
  let loaded = $state(false);

  $effect(() => {
    const viewer = auth.parent?.toLowerCase();
    const { type, id } = subject;
    loaded = false;
    getLikeCount(type, id, viewer).then((res) => {
      if (!res) { loaded = true; return; }
      count = res.count;
      liked = res.likedByViewer;
      viewerUid = res.viewerUid;
      loaded = true;
    });
  });

  async function handleClick() {
    if (inFlight || !loaded) return;
    inFlight = true;

    const prevLiked = liked;
    const prevCount = count;
    const prevUid = viewerUid;
    liked = !prevLiked;
    count = prevLiked ? prevCount - 1 : prevCount + 1;

    try {
      const r = await toggleLike(subject, prevLiked, prevUid);
      if (r === null) {
        liked = prevLiked;
        count = prevCount;
        viewerUid = prevUid;
      } else {
        liked = r.liked;
        count = r.count;
        const viewer = auth.parent?.toLowerCase();
        const fresh = await getLikeCount(subject.type, subject.id, viewer);
        if (fresh) viewerUid = fresh.viewerUid;
      }
    } catch (err) {
      console.error("[LikeButton]", err);
      liked = prevLiked;
      count = prevCount;
      viewerUid = prevUid;
    } finally {
      inFlight = false;
    }
  }
</script>

<button
  class="like-btn"
  class:liked
  class:loading={!loaded}
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
  <span class="count" class:zero={count === 0 && !liked}>
    {#if !loaded}·{:else}{count > 0 ? count : ""}{/if}
  </span>
</button>

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
</style>
