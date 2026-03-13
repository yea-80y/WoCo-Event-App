<script lang="ts">
  import type { UserProfile } from "@woco/shared";
  import { getProfile } from "../../api/profiles.js";
  import { navigate } from "../../router/router.svelte.js";
  import UserAvatar from "./UserAvatar.svelte";
  import { onMount } from "svelte";

  interface Props {
    address: string;
    /** Compact = avatar only (for tight spaces). Default = avatar + name. */
    compact?: boolean;
  }

  let { address, compact = false }: Props = $props();

  let profile = $state<UserProfile | null>(null);

  const displayName = $derived(
    profile?.displayName || `${address.slice(0, 6)}...${address.slice(-4)}`,
  );

  function handleClick(e: Event) {
    e.stopPropagation();
    navigate(`/profile/${address.toLowerCase()}`);
  }

  onMount(() => {
    getProfile(address).then((p) => {
      profile = p;
    });
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_interactive_supports_focus -->
<div class="creator-chip" role="button" onclick={handleClick} title={displayName}>
  <UserAvatar {address} size={compact ? 20 : 22} profile={profile} />
  {#if !compact}
    <span class="creator-name">{displayName}</span>
  {/if}
</div>

<style>
  .creator-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    cursor: pointer;
    transition: opacity var(--transition);
    text-decoration: none;
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
