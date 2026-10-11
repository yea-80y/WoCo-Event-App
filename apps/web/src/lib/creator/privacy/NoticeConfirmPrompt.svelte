<!--
  Shown before publishing a paid event or a site with events, when the organiser
  has not confirmed their privacy notice. The server refuses every sale until
  they have (apps/server/src/lib/legal/notice-gate.ts), so this is a heads-up
  with a way through, not the rule itself: they can confirm now in a new tab
  (keeping this form), check again, or publish and sell once they confirm.
-->
<script lang="ts">
  import { NOTICE_EDITOR_URL, type OwnNoticeStatus } from "../../legal/own-notice-status.js";

  interface Props {
    status: Exclude<OwnNoticeStatus, "confirmed">;
    /** "event" before an event publish; "site" before a site deploy. */
    what: "event" | "site";
    checking?: boolean;
    onrecheck: () => void;
    onpublishanyway: () => void;
  }

  let { status, what, checking = false, onrecheck, onpublishanyway }: Props = $props();
</script>

<div class="notice-prompt" role="alert">
  <p class="title">Confirm your privacy notice</p>
  {#if status === "missing"}
    <p>
      Attendees see your privacy notice whenever they buy from you, so tickets only go on sale once you've
      confirmed it. We've pre-filled it - check it, fill the gaps and confirm. It takes a few minutes.
    </p>
  {:else}
    <p>
      We couldn't check your privacy notice just now. Tickets only go on sale once it's confirmed - check again,
      or open it to make sure.
    </p>
  {/if}
  <div class="actions">
    <a class="primary" href={NOTICE_EDITOR_URL} target="_blank" rel="noopener noreferrer">Review my notice</a>
    <button class="secondary" onclick={onrecheck} disabled={checking}>
      {checking ? "Checking…" : "I've confirmed it - continue"}
    </button>
  </div>
  <button class="link" onclick={onpublishanyway} disabled={checking}>
    Publish the {what} now - tickets go on sale once I confirm
  </button>
</div>

<style>
  .notice-prompt {
    border: 1px solid var(--accent);
    border-radius: var(--radius-md, 8px);
    padding: 0.875rem 1rem;
    background: var(--bg-elevated, var(--card-bg));
    color: var(--text-primary, var(--text));
    font-size: 0.875rem;
    line-height: 1.5;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .notice-prompt p {
    margin: 0;
  }
  .title {
    font-weight: 600;
    font-size: 0.9375rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .primary,
  .secondary {
    padding: 0.5rem 0.875rem;
    border-radius: var(--radius-sm, 6px);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
  }
  .primary {
    background: var(--accent);
    color: var(--accent-ink);
    border: 1px solid var(--accent);
  }
  .secondary {
    background: transparent;
    color: var(--text-primary, var(--text));
    border: 1px solid var(--border);
  }
  .link {
    align-self: flex-start;
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: var(--text-muted, var(--muted));
    text-decoration: underline;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
