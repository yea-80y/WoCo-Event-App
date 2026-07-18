<script lang="ts">
  import type { MarketingContact, MarketingBroadcastResult } from "@woco/shared";
  import { sendMarketingBroadcast } from "../../api/marketing.js";

  interface Props {
    contacts: MarketingContact[];
    suppressedEmails: Set<string>;
  }

  let { contacts, suppressedEmails }: Props = $props();

  let fromName = $state("");
  let subject = $state("");
  let body = $state("");
  let sending = $state(false);
  let showPreview = $state(false);
  let result = $state<MarketingBroadcastResult | null>(null);
  let error = $state<string | null>(null);

  const recipients = $derived(
    contacts
      .filter((c) => !suppressedEmails.has(c.email))
      .map((c) => ({
        email: c.email,
        name: [c.firstName, c.lastName].filter(Boolean).join(" ") || undefined,
      })),
  );

  function wrapHtmlEmail(text: string, brand: string): string {
    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #e0e0e0; background: #1a1a2e; padding: 2rem;">
  <div style="max-width: 600px; margin: 0 auto; background: #16213e; border-radius: 12px; padding: 2rem;">
    <h2 style="color: #fff; margin: 0 0 1rem;">${brand}</h2>
    <div style="color: #c0c0c0; line-height: 1.6; font-size: 15px;">${escaped}</div>
  </div>
</body></html>`;
  }

  async function handleSend(): Promise<void> {
    error = null;
    result = null;
    if (!fromName.trim()) { error = "Add the name this email is from (your brand)."; return; }
    if (!subject.trim()) { error = "Subject is required."; return; }
    if (!body.trim()) { error = "Message body is required."; return; }
    if (recipients.length === 0) { error = "No reachable contacts to send to."; return; }

    if (!confirm(`Send "${subject.trim()}" to ${recipients.length.toLocaleString()} contact${recipients.length === 1 ? "" : "s"}?`)) {
      return;
    }

    sending = true;
    try {
      result = await sendMarketingBroadcast(
        fromName.trim(),
        subject.trim(),
        wrapHtmlEmail(body.trim(), fromName.trim()),
        recipients,
      );
      if (result.sent > 0) {
        subject = "";
        body = "";
        showPreview = false;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "Send failed.";
    } finally {
      sending = false;
    }
  }
</script>

<section class="composer" aria-label="Compose broadcast">
  <div class="reach">
    Reaches <strong>{recipients.length.toLocaleString()}</strong> contact{recipients.length === 1 ? "" : "s"}
    {#if suppressedEmails.size > 0}
      <span class="reach-sup">· {suppressedEmails.size.toLocaleString()} unsubscribed are excluded automatically</span>
    {/if}
  </div>

  <label class="field">
    <span>From</span>
    <input type="text" bind:value={fromName} maxlength="100" placeholder="Your brand or venue name" />
  </label>

  <label class="field">
    <span>Subject</span>
    <input type="text" bind:value={subject} maxlength="200" placeholder="What's happening?" />
  </label>

  <label class="field">
    <span>Message</span>
    <textarea bind:value={body} rows="8" placeholder="Write your update — new event, lineup news, anything worth their inbox."></textarea>
  </label>

  <p class="footer-note">
    Every email automatically carries a "you opted in to updates from {fromName.trim() || "your brand"}"
    line and an unsubscribe link — you don't need to add either.
  </p>

  {#if showPreview}
    <div class="preview">
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- preview of organiser's own content, escaped in wrapHtmlEmail -->
      {@html wrapHtmlEmail(body.trim() || "Your message will appear here.", fromName.trim() || "Your brand")}
    </div>
  {/if}

  {#if result}
    <div class="result" class:has-failures={result.failed > 0}>
      Sent to {result.sent.toLocaleString()} contact{result.sent === 1 ? "" : "s"}.
      {#if result.suppressed > 0}<br />{result.suppressed.toLocaleString()} skipped (unsubscribed).{/if}
      {#if result.failed > 0}<br />{result.failed.toLocaleString()} failed.{/if}
      <br /><span class="cap">{result.capRemaining.toLocaleString()} sends left in your daily allowance.</span>
    </div>
  {/if}
  {#if error}<p class="err">{error}</p>{/if}

  <div class="actions">
    <button class="btn-ghost" onclick={() => (showPreview = !showPreview)}>
      {showPreview ? "Hide preview" : "Preview"}
    </button>
    <button
      class="btn-primary"
      disabled={sending || recipients.length === 0 || !subject.trim() || !body.trim() || !fromName.trim()}
      onclick={() => void handleSend()}
    >
      {sending ? "Sending…" : "Send broadcast"}
    </button>
  </div>
</section>

<style>
  .composer {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-surface);
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  .reach {
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }
  .reach strong { color: var(--accent-text); font-family: var(--font-mono); }
  .reach-sup { color: var(--text-muted); }

  .field { display: flex; flex-direction: column; gap: 0.35rem; }
  .field span {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .field input, .field textarea {
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text);
    padding: 0.625rem 0.75rem;
    font-size: 0.875rem;
    font-family: var(--font-body);
    width: 100%;
    transition: border-color var(--transition);
    resize: vertical;
  }
  .field input:focus, .field textarea:focus { border-color: var(--accent); outline: none; }
  .field input::placeholder, .field textarea::placeholder { color: var(--text-dim); }

  .footer-note {
    font-size: 0.75rem;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
    padding: 0.625rem 0.75rem;
    border-left: 2px solid var(--accent);
    background: var(--accent-subtle);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  }

  .preview {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    max-height: 340px;
    overflow-y: auto;
  }

  .result {
    font-size: 0.8125rem;
    color: var(--text);
    border: 1px solid color-mix(in srgb, var(--success) 40%, var(--border));
    background: var(--accent-subtle);
    border-radius: var(--radius-md);
    padding: 0.75rem 0.875rem;
    line-height: 1.6;
  }
  .result.has-failures { border-color: color-mix(in srgb, var(--warning) 40%, var(--border)); }
  .result .cap { color: var(--text-muted); font-size: 0.75rem; }

  .err { color: var(--error); font-size: 0.8125rem; margin: 0; }

  .actions { display: flex; gap: 0.5rem; justify-content: flex-end; }

  .btn-primary {
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 700;
    font-size: 0.875rem;
    padding: 0.625rem 1.125rem;
    border-radius: var(--radius-md);
    transition: background var(--transition), opacity var(--transition);
  }
  .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-ghost {
    border: 1px solid var(--border);
    color: var(--text-secondary);
    font-size: 0.875rem;
    padding: 0.625rem 1.125rem;
    border-radius: var(--radius-md);
    transition: border-color var(--transition), color var(--transition);
  }
  .btn-ghost:hover { border-color: var(--border-hover); color: var(--text); }
</style>
