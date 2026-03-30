<script lang="ts">
  import { router } from './lib/router/router.svelte.ts';
  import Header from './lib/components/Header.svelte';
  import VerifyHash from './lib/components/VerifyHash.svelte';
  import RegisterHash from './lib/components/RegisterHash.svelte';
  import BrowseRegistry from './lib/components/BrowseRegistry.svelte';
  import MyRegistrations from './lib/components/MyRegistrations.svelte';
</script>

<Header />

<main>
  {#if router.route === 'verify'}
    <VerifyHash />
  {:else if router.route === 'register'}
    <RegisterHash />
  {:else if router.route === 'browse'}
    <BrowseRegistry />
  {:else if router.route === 'my'}
    <MyRegistrations />
  {/if}
</main>

<footer class="footer">
  <p>
    World Computer Registry &mdash; on-chain content hash verification.
    <a href="https://github.com/yea-80y/WoCo-Event-App" target="_blank" rel="noopener">Source</a>
  </p>
</footer>

<style>
  main {
    min-height: calc(100vh - 200px);
  }

  .footer {
    border-top: 1px solid var(--border);
    padding: 1.5rem 0;
    margin-top: 3rem;
    text-align: center;
  }

  .footer p {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin: 0;
  }
</style>
