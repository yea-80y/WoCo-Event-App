<script lang="ts">
  import type { UserProfile } from "@woco/shared";
  import { profileLikeSubject } from "@woco/shared";
  import { getProfile } from "../../api/profiles.js";
  import { rememberLabel } from "../../likes/label-cache.js";
  import { navigate } from "../../router/router.svelte.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import UserAvatar from "./UserAvatar.svelte";
  import LikeButton from "../likes/LikeButton.svelte";
  import { onMount } from "svelte";

  interface Props {
    address: string;
    /** Compact = avatar only (for tight spaces). Default = avatar + name. */
    compact?: boolean;
    /** Show a Follow pill when this creator has a claimed sub-ENS name. */
    showFollow?: boolean;
  }

  let { address, compact = false, showFollow = false }: Props = $props();

  let profile = $state<UserProfile | null>(null);

  const displayName = $derived(
    profile?.displayName || `${address.slice(0, 6)}...${address.slice(-4)}`,
  );

  // Follow attaches to a NAME — only followable once they've claimed a sub-ENS,
  // and never on your own identity.
  const canFollow = $derived(
    showFollow &&
      !!profile?.subEnsLabel &&
      auth.parent?.toLowerCase() !== address.toLowerCase(),
  );

  function handleClick(e: Event) {
    e.stopPropagation();
    navigate(`/profile/${address.toLowerCase()}`);
  }

  onMount(() => {
    getProfile(address).then((p) => {
      profile = p;
      rememberLabel(p?.subEnsLabel); // feed the client name-resolution cache
    });
  });
</script>

<div class="creator-chip-wrap">
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div class="creator-chip" role="button" onclick={handleClick} title={displayName}>
    <UserAvatar {address} size={compact ? 20 : 22} profile={profile} />
    {#if !compact}
      <span class="creator-name">{displayName}</span>
    {/if}
  </div>
  {#if canFollow}
    <LikeButton subject={profileLikeSubject(profile!.subEnsLabel!)} variant="follow" />
  {/if}
</div>

<style>
  .creator-chip-wrap {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    max-width: 100%;
  }

  .creator-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    cursor: pointer;
    transition: opacity var(--transition);
    text-decoration: none;
    min-width: 0;
    max-width: 100%;
  }

  .creator-chip:hover {
    opacity: 0.8;
  }

  .creator-name {
    font-size: 0.75rem;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1;
  }

  .creator-chip:hover .creator-name {
    color: var(--accent-text);
  }
</style>
