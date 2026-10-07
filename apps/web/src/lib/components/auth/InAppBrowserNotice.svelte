<!--
  Shown at the top of the sign-in sheet inside a social app's built-in browser,
  where neither passkeys nor Google sign-in can work (#812). Offers the one
  thing that helps: reopening this same page in a real browser. Lazy - only
  people inside such a browser download it.
-->
<script lang="ts">
  import {
    escapeLink,
    ESCAPE_FAILED_PARAM,
    ESCAPE_ROUTE_PARAM,
    IN_APP_NAMES,
    type InAppBrowser,
  } from "../../browser/in-app-browser.js";

  interface Props {
    found: InAppBrowser;
  }

  let { found }: Props = $props();

  const page = new URL(window.location.href);
  /** The Android fallback brought us back here: Chrome is not installed. */
  const chromeFailed = page.searchParams.get(ESCAPE_FAILED_PARAM) === "1";
  page.searchParams.delete(ESCAPE_FAILED_PARAM);
  page.searchParams.delete(ESCAPE_ROUTE_PARAM);

  const link = $derived(escapeLink(found, page, { chromeFailed }));
  const appName = $derived(IN_APP_NAMES[found.app]);
  const label = $derived(
    link?.kind === "chrome" ? "Open in Chrome" : link?.kind === "safari" ? "Open in Safari" : "Open in your browser",
  );
  const steps = $derived(
    found.os === "ios"
      ? "Or tap ••• or the share button, then choose Open in browser."
      : "Or tap ⋮, then choose Open in browser.",
  );

  let copied = $state(false);

  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(page.href);
      copied = true;
    } catch {
      copied = false;
    }
  }
</script>

<section class="in-app" role="note" aria-labelledby="in-app-title">
  <p id="in-app-title" class="title">Open WoCo in your browser to sign in</p>
  <p class="body">
    {appName ? `${appName}'s` : "This app's"} built-in browser can't use passkeys or Google sign-in.
  </p>
  {#if chromeFailed}
    <p class="body">Chrome didn't open - try your usual browser instead.</p>
  {/if}
  {#if link}
    <a class="open-btn" href={link.href}>{label}</a>
  {/if}
  <p class="steps">{steps}</p>
  <button type="button" class="copy-btn" onclick={copyLink}>
    {copied ? "Link copied - paste it into your browser" : "Copy link"}
  </button>
</section>

<style>
  .in-app {
    display: grid;
    gap: 0.5rem;
    padding: 0.875rem 1rem;
    margin-bottom: 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
  }
  .title {
    margin: 0;
    font-weight: 600;
    color: var(--text);
  }
  .body,
  .steps {
    margin: 0;
    font-size: 0.875rem;
    color: var(--text-secondary);
  }
  .open-btn {
    display: block;
    padding: 0.7rem 1rem;
    border-radius: var(--radius-md);
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 600;
    text-align: center;
    text-decoration: none;
  }
  .copy-btn {
    justify-self: start;
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent-text);
    font: inherit;
    font-size: 0.875rem;
    cursor: pointer;
  }
</style>
