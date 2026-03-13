<script lang="ts">
  import type { UserProfile } from "@woco/shared";
  import { getProfile } from "../../api/profiles.js";
  import { onMount } from "svelte";

  interface Props {
    address: string;
    size?: number;
    /** If provided, skip fetch and use this data directly */
    profile?: UserProfile | null;
    clickable?: boolean;
    onclick?: () => void;
  }

  let { address, size = 32, profile: propProfile, clickable = false, onclick }: Props = $props();

  const BEE_GATEWAY = import.meta.env.VITE_GATEWAY_URL || "https://gateway.woco-net.com";

  let fetched = $state<UserProfile | null>(propProfile ?? null);
  let loaded = $state(propProfile !== undefined);

  // Deterministic gradient from address
  function addressGradient(addr: string): string {
    const hex = addr.replace("0x", "").slice(0, 12);
    const h1 = parseInt(hex.slice(0, 4), 16) % 360;
    const h2 = (h1 + 40 + (parseInt(hex.slice(4, 8), 16) % 80)) % 360;
    return `linear-gradient(135deg, hsl(${h1}, 55%, 45%), hsl(${h2}, 65%, 35%))`;
  }

  const avatarUrl = $derived(
    fetched?.avatarRef ? `${BEE_GATEWAY}/bytes/${fetched.avatarRef}` : null,
  );

  // Only show an initial if the user has set a display name
  const initial = $derived(
    fetched?.displayName ? fetched.displayName.slice(0, 1).toUpperCase() : null,
  );

  onMount(() => {
    if (propProfile !== undefined) return;
    getProfile(address).then((p) => {
      fetched = p;
      loaded = true;
    });
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="avatar"
  class:clickable
  style="width:{size}px;height:{size}px;background:{avatarUrl ? 'none' : addressGradient(address)};font-size:{Math.max(size * 0.38, 10)}px"
  role={clickable ? "button" : "img"}
  tabindex={clickable ? 0 : -1}
  onclick={() => clickable && onclick?.()}
>
  {#if avatarUrl}
    <img
      src={avatarUrl}
      alt=""
      style="width:{size}px;height:{size}px"
      class="avatar-img"
    />
  {:else if initial}
    <span class="avatar-initials">{initial}</span>
  {:else}
    <!-- Generic person silhouette -->
    <svg
      width="{Math.round(size * 0.52)}"
      height="{Math.round(size * 0.52)}"
      viewBox="0 0 24 24"
      fill="none"
      class="avatar-icon"
    >
      <circle cx="12" cy="8" r="4" fill="rgba(255,255,255,0.75)" />
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" fill="rgba(255,255,255,0.75)" />
    </svg>
  {/if}
</div>

<style>
  .avatar {
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    flex-shrink: 0;
    position: relative;
  }

  .avatar.clickable {
    cursor: pointer;
    transition: opacity var(--transition), box-shadow var(--transition);
  }

  .avatar.clickable:hover {
    opacity: 0.85;
    box-shadow: 0 0 0 2px var(--accent-subtle);
  }

  .avatar-img {
    object-fit: cover;
    border-radius: 50%;
  }

  .avatar-initials {
    color: rgba(255, 255, 255, 0.85);
    font-weight: 600;
    letter-spacing: 0.02em;
    user-select: none;
    line-height: 1;
  }

  .avatar-icon {
    flex-shrink: 0;
  }
</style>
