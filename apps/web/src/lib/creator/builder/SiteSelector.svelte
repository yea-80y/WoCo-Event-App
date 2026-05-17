<script lang="ts">
  import type { SiteDirectoryEntry } from "@woco/shared";
  import { getCreatorSites } from "../../api/sites.js";
  import { navigate } from "../../router/router.svelte.js";
  import { onMount } from "svelte";

  interface Props {
    selectedSiteIds: string[];
  }
  let { selectedSiteIds = $bindable([]) }: Props = $props();

  type LoadState = "loading" | "ready" | "empty" | "error";

  let loadState = $state<LoadState>("loading");
  let sites = $state<SiteDirectoryEntry[]>([]);

  onMount(async () => {
    const result = await getCreatorSites();
    if (result.ok && result.data) {
      sites = result.data;
      loadState = sites.length === 0 ? "empty" : "ready";
    } else {
      loadState = "error";
    }
  });

  function toggle(siteId: string) {
    if (selectedSiteIds.includes(siteId)) {
      selectedSiteIds = selectedSiteIds.filter(id => id !== siteId);
    } else {
      selectedSiteIds = [...selectedSiteIds, siteId];
    }
  }
</script>

<div class="ss-wrap">
  <p class="ss-label">Add to my websites</p>

  {#if loadState === "loading"}
    <p class="ss-hint">Loading your sites…</p>

  {:else if loadState === "error"}
    <p class="ss-hint ss-error">Could not load sites.</p>

  {:else if loadState === "empty"}
    <p class="ss-hint">
      No sites yet.
      <button class="ss-link" onclick={() => navigate("/creator/sites")}>Build a site →</button>
    </p>

  {:else}
    <ul class="ss-list">
      {#each sites as site (site.siteId)}
        {@const checked = selectedSiteIds.includes(site.siteId)}
        <li class="ss-item" class:checked>
          <label class="ss-check-label">
            <input type="checkbox" class="ss-checkbox" {checked}
              onchange={() => toggle(site.siteId)} />
            <span class="ss-site-name">{site.brandName || site.siteId}</span>
            {#if site.deployedUrl}
              <span class="ss-site-url">{site.deployedUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>
            {/if}
          </label>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .ss-wrap { display: flex; flex-direction: column; gap: 0.5rem; }

  .ss-label {
    font-size: 0.875rem; font-weight: 600; color: var(--text); margin: 0;
  }

  .ss-hint { margin: 0; font-size: 0.8125rem; color: var(--text-muted); }
  .ss-error { color: var(--error); }
  .ss-link {
    background: none; border: none; padding: 0; cursor: pointer;
    color: var(--accent-text); font-size: inherit; text-decoration: underline;
  }

  .ss-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; }

  .ss-item {
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--bg-surface); transition: border-color var(--transition);
  }
  .ss-item.checked { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 5%, var(--bg-surface)); }

  .ss-check-label {
    display: flex; align-items: center; gap: 0.625rem;
    padding: 0.5rem 0.75rem; cursor: pointer; width: 100%;
  }

  .ss-checkbox { flex-shrink: 0; accent-color: var(--accent); }

  .ss-site-name { font-size: 0.875rem; font-weight: 600; color: var(--text); flex: 1; min-width: 0; }

  .ss-site-url {
    font-size: 0.75rem; font-family: var(--font-mono); color: var(--text-muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 12rem;
  }
</style>
