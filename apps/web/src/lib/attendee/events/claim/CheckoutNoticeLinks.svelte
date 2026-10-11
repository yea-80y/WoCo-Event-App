<script lang="ts">
  /**
   * The two links every checkout carries: the ORGANISER's privacy notice (they
   * are the controller for what the buyer enters) and WoCo's own policy (what
   * WoCo is responsible for in its own right). Both open on the canonical host in
   * a new tab, so a half-filled form is never lost and an organiser's site needs
   * no legal route of its own (#605).
   */
  import { ORGANISER_NOTICE_LINK_LABEL, WOCO_POLICY_LINK_LABEL } from "@woco/shared";
  import { organiserNoticeUrl, WOCO_POLICY_URL } from "../../../legal/organiser-notice.js";

  interface Props {
    eventId: string;
    organiserName?: string;
  }
  let { eventId, organiserName }: Props = $props();
</script>

<span class="notice-links">
  <a href={organiserNoticeUrl(eventId)} target="_blank" rel="noopener noreferrer"
    >{organiserName ? `${organiserName}'s privacy notice` : ORGANISER_NOTICE_LINK_LABEL}</a
  >
  <span aria-hidden="true">·</span>
  <a href={WOCO_POLICY_URL} target="_blank" rel="noopener noreferrer">{WOCO_POLICY_LINK_LABEL}</a>
</span>

<style>
  .notice-links a {
    color: var(--accent-text, var(--accent));
    text-decoration: underline;
  }
</style>
