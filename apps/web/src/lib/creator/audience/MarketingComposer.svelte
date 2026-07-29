<script lang="ts">
  import type { MarketingContact, MarketingBroadcastResult, EventDirectoryEntry } from "@woco/shared";
  import { sendMarketingBroadcast, sendMarketingTest } from "../../api/marketing.js";
  import { getEventsByCreator } from "../../api/events.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { firstImageUrl } from "../../components/site/image-fallback.js";
  import { WOCO_GATEWAY_URL } from "../../swarm/gateways.js";
  import {
    buildEventAnnouncementHtml,
    buildPlainMessageHtml,
    publicEventUrl,
  } from "./event-announcement.js";

  interface Props {
    contacts: MarketingContact[];
    suppressedEmails: Set<string>;
    /** Preselects the event picker once events load — the post-publish
     *  "Announce to your audience" deep-link (?announce=eventId). */
    initialEventId?: string;
  }

  let { contacts, suppressedEmails, initialEventId }: Props = $props();

  let fromName = $state("");
  let subject = $state("");
  let body = $state("");
  let sending = $state(false);
  let showPreview = $state(false);
  let result = $state<MarketingBroadcastResult | null>(null);
  let error = $state<string | null>(null);

  /** Attaching an event is what turns a message into an on-sale announcement —
   *  the shape almost every broadcast takes. Optional: a plain note still works. */
  let events = $state<EventDirectoryEntry[]>([]);
  let selectedEventId = $state("");
  let eventsLoaded = $state(false);

  const selectedEvent = $derived(events.find((e) => e.eventId === selectedEventId) ?? null);

  $effect(() => {
    const owner = auth.parent;
    if (!owner || eventsLoaded) return;
    eventsLoaded = true;
    void getEventsByCreator(owner)
      .then((list) => {
        // Newest first — an on-sale announcement is nearly always the latest.
        events = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        if (initialEventId && events.some((e) => e.eventId === initialEventId)) {
          selectedEventId = initialEventId;
        }
      })
      .catch(() => {
        // Non-fatal: the composer still sends a plain message without a picker.
        events = [];
      });
  });

  function buildHtml(): string {
    const brand = fromName.trim() || "Your brand";
    const text = body.trim();
    const ev = selectedEvent;
    if (!ev) return buildPlainMessageHtml(brand, text);
    return buildEventAnnouncementHtml({
      brand,
      message: text,
      event: {
        title: ev.title,
        tagline: ev.tagline,
        startDate: ev.startDate,
        location: ev.location,
        imageUrl: firstImageUrl(ev.imageHash, WOCO_GATEWAY_URL),
      },
      eventUrl: publicEventUrl(ev.eventId, window.location.origin),
    });
  }

  const recipients = $derived(
    contacts
      .filter((c) => !suppressedEmails.has(c.email))
      .map((c) => ({
        email: c.email,
        name: [c.firstName, c.lastName].filter(Boolean).join(" ") || undefined,
      })),
  );

  /** Remembered across visits — the organiser tests into the same inbox every time. */
  const TEST_EMAIL_KEY = "woco:test-send-email";
  let testEmail = $state(localStorage.getItem(TEST_EMAIL_KEY) ?? "");
  let testSending = $state(false);
  let testNote = $state<string | null>(null);

  async function handleSendTest(): Promise<void> {
    error = null;
    testNote = null;
    if (!fromName.trim() || !subject.trim() || !body.trim()) {
      error = "Fill in from, subject and message before sending a test.";
      return;
    }
    const to = testEmail.trim();
    if (!to) { error = "Enter the address to send the test to."; return; }

    testSending = true;
    try {
      const res = await sendMarketingTest(fromName.trim(), subject.trim(), buildHtml(), to);
      localStorage.setItem(TEST_EMAIL_KEY, to);
      if (res.sent > 0) {
        testNote = `Test sent to ${to} — check that inbox before broadcasting.`;
      } else if (res.suppressed > 0) {
        testNote = `${to} has unsubscribed from your emails, so nothing was sent. Test with a different address.`;
      } else {
        error = res.errors?.[0] ?? "Test send failed.";
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "Test send failed.";
    } finally {
      testSending = false;
    }
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
        buildHtml(),
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

  {#if events.length > 0}
    <label class="field">
      <span>Announce an event</span>
      <select bind:value={selectedEventId}>
        <option value="">No event — just a message</option>
        {#each events as ev (ev.eventId)}
          <option value={ev.eventId}>{ev.title}</option>
        {/each}
      </select>
    </label>
    {#if selectedEvent}
      <p class="attached">
        Adds the artwork, date, venue and a <strong>Get tickets</strong> button linking to
        your event page. Write the words below — no need to repeat the details.
      </p>
    {/if}
  {/if}

  <label class="field">
    <span>Message</span>
    <textarea bind:value={body} rows="8" placeholder="Write your update — new event, lineup news, anything worth their inbox."></textarea>
  </label>

  <p class="footer-note">
    Every email automatically carries a "you opted in to updates from {fromName.trim() || "your brand"}"
    line, an unsubscribe link, and our postal address — the three things the law requires.
    You don't need to add any of them.
  </p>

  {#if showPreview}
    <div class="preview">
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- organiser's own content, escaped by event-announcement.ts -->
      {@html buildHtml()}
      <p class="preview-note">
        The unsubscribe link and postal address are added by the server on send, so
        they are not shown here.
      </p>
    </div>
  {/if}

  <div class="test-row">
    <input
      type="email"
      bind:value={testEmail}
      placeholder="your@email.com"
      aria-label="Test send address"
    />
    <button
      class="btn-ghost"
      disabled={testSending || !subject.trim() || !body.trim() || !fromName.trim() || !testEmail.trim()}
      onclick={() => void handleSendTest()}
    >
      {testSending ? "Sending…" : "Send test"}
    </button>
  </div>
  {#if testNote}<p class="test-note">{testNote}</p>{/if}

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

  .attached {
    font-size: 0.75rem;
    color: var(--text-muted);
    line-height: 1.5;
    margin: -0.375rem 0 0;
  }
  .attached strong { color: var(--text-secondary); }

  .preview-note {
    font-size: 0.6875rem;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
    padding: 0.5rem 0.75rem;
    border-top: 1px solid var(--border);
  }

  .field select,
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

  .test-row {
    display: flex;
    gap: 0.5rem;
  }

  .test-row input {
    flex: 1;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text);
    padding: 0.625rem 0.75rem;
    font-size: 0.875rem;
    font-family: var(--font-body);
    transition: border-color var(--transition);
  }
  .test-row input:focus { border-color: var(--accent); outline: none; }
  .test-row input::placeholder { color: var(--text-dim); }
  .test-row .btn-ghost { white-space: nowrap; }
  .test-row .btn-ghost:disabled { opacity: 0.4; cursor: not-allowed; }

  .test-note {
    font-size: 0.75rem;
    color: var(--text-secondary);
    margin: -0.375rem 0 0;
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
