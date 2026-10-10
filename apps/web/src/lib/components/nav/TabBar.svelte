<!--
  The bottom bar, shared by WoCo and organiser mode so both read as one app:
  five slots in the same places, a lime key in the middle, and your profile at
  the end. Each shell passes its own items; the bar never decides what they do.

  The slot count is fixed by the caller and never grows after paint. A tab that
  appeared once sign-in finished used to shove the others sideways.
-->
<script lang="ts" module>
  import type { NavIconName } from "./NavIcon.svelte";

  export interface TabItem {
    id: string;
    label: string;
    /** A drawn glyph. Omit for the profile slot, which shows `avatar`. */
    icon?: NavIconName;
    /** The account whose picture fills the profile slot; null = signed out. */
    avatar?: string | null;
    active?: boolean;
    /** The lime key in the middle, which opens something rather than a page. */
    key?: boolean;
    /** The key's menu or sheet is open. */
    expanded?: boolean;
    haspopup?: "menu" | "dialog";
    onclick: () => void;
  }
</script>

<script lang="ts">
  import NavIcon from "./NavIcon.svelte";
  import UserAvatar from "../profile/UserAvatar.svelte";

  interface Props {
    items: TabItem[];
    label: string;
  }
  let { items, label }: Props = $props();

  // A key opens a sheet over the page rather than changing it, so it has no
  // active state of its own; each press replays its icon instead.
  let pulses = $state<Record<string, number>>({});

  function press(item: TabItem) {
    if (item.key) pulses[item.id] = (pulses[item.id] ?? 0) + 1;
    item.onclick();
  }
</script>

<nav class="tab-bar" aria-label={label}>
  {#each items as item (item.id)}
    <button
      type="button"
      class="tab"
      class:active={item.active}
      class:key={item.key}
      aria-current={item.active ? "page" : undefined}
      aria-haspopup={item.haspopup}
      aria-expanded={item.haspopup ? !!item.expanded : undefined}
      onclick={() => press(item)}
    >
      <span class="glyph">
        {#if item.icon}
          <NavIcon
            name={item.icon}
            active={item.active}
            open={item.expanded}
            pulse={pulses[item.id] ?? 0}
          />
        {:else if item.avatar}
          <span class="avatar"><UserAvatar address={item.avatar} size={24} /></span>
        {:else}
          <span class="avatar avatar--empty" aria-hidden="true"></span>
        {/if}
      </span>
      <span class="label">{item.label}</span>
    </button>
  {/each}
</nav>

<style>
  .tab-bar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 100;
    display: flex;
    justify-content: center;
    padding: 0.375rem 0.25rem max(0.5rem, env(safe-area-inset-bottom));
    background: var(--bg-elevated);
    border-top: 1px solid var(--border);
  }

  .tab {
    flex: 1;
    min-width: 0;
    max-width: 5.5rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    gap: 0.3125rem;
    padding: 0.375rem 0.125rem 0.125rem;
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    transition: color var(--transition), transform var(--transition);
    -webkit-tap-highlight-color: transparent;
  }
  .tab:hover { color: var(--text-secondary); }
  .tab:active { transform: scale(0.94); }
  .tab.active { color: var(--text); }
  .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

  .glyph {
    display: grid;
    place-items: center;
    width: 2rem;
    height: 1.75rem;
  }

  .tab.key { color: var(--text); }
  .tab.key .glyph {
    width: 2.125rem;
    height: 1.875rem;
    background: var(--accent);
    color: var(--accent-ink);
    border-radius: var(--radius-sm);
    transition: background var(--transition);
  }
  .tab.key:hover .glyph { background: var(--accent-hover); }
  .tab.key:active .glyph { background: var(--accent-press); }

  .avatar {
    display: grid;
    place-items: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
    line-height: 0;
    transition: box-shadow 0.2s var(--ease-out);
  }
  .avatar--empty { background: var(--border); }
  .tab.active .avatar { box-shadow: 0 0 0 2px var(--bg-elevated), 0 0 0 4px var(--accent); }

  .label {
    font-family: var(--font-mono);
    font-size: 0.59375rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    line-height: 1;
    white-space: nowrap;
  }

  @media (prefers-reduced-motion: reduce) {
    .tab, .tab.key .glyph, .avatar { transition: none; }
  }
</style>
