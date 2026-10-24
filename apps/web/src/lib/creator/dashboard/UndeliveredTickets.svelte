<script lang="ts">
  /**
   * Tickets whose email did not arrive (#983), at the top of the event's dashboard.
   * Shown only when there is one. The buyer gets in touch; the organiser checks them
   * against the order and sends the same ticket to the address they give. The held
   * copy is opened here, with the organiser's own keys, never by the server.
   */
  import { MAILABLE_EMAIL_RE } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { listUndelivered, resendUndelivered, type UndeliveredRow } from "../../api/undelivered.js";

  interface Props {
    eventId: string;
  }

  let { eventId }: Props = $props();

  let rows = $state<UndeliveredRow[]>([]);
  /** The sale whose resend form is open. */
  let openFor = $state<string | null>(null);
  let to = $state("");
  let buyerName = $state("");
  let sending = $state(false);
  let error = $state<string | null>(null);
  let sent = $state<{ sessionId: string; to: string } | null>(null);

  async function refresh(): Promise<void> {
    const r = await listUndelivered(eventId).catch(() => null);
    if (r?.ok && r.data) rows = r.data;
  }
  void refresh();

  /** What went wrong, in the buyer's terms - never the provider's code. */
  function reasonText(reason: string): string {
    if (reason.startsWith("Bounce/Permanent")) return "The address doesn't exist - usually a typo.";
    if (reason === "Bounce/Transient/MailboxFull") return "The buyer's inbox was full.";
    if (reason.startsWith("Bounce/Transient") || reason === "Reject") {
      return "Their email provider refused the message. It will be resent as a link to the ticket.";
    }
    return "The email didn't arrive.";
  }

  const BLOCKED: Record<string, string> = {
    SALE_VOID: "Refunded - these tickets no longer work.",
    EVENT_CANCELLED: "The event is cancelled.",
    EVENT_ENDED: "The event has ended.",
    NO_HELD_COPY: "No copy of these tickets was kept. Contact WoCo support to have them reissued.",
    COPY_UNREADABLE: "These tickets can't be read right now. Try again later.",
    CANCELLATIONS_UNREADABLE: "Can't check this event right now. Try again later.",
  };

  const looksMailable = (s: string) => MAILABLE_EMAIL_RE.test(s.trim());

  function startResend(sessionId: string): void {
    openFor = sessionId;
    to = "";
    buyerName = "";
    error = null;
    sent = null;
  }

  async function resend(row: UndeliveredRow): Promise<void> {
    if (sending || !looksMailable(to)) return;
    sending = true;
    error = null;
    try {
      await auth.ensureOrganiserUnlock();
      let secrets = await auth.getAccountSecrets();
      if (!secrets && (await auth.ensureAccountSetup({ identity: true }))) secrets = await auth.getAccountSecrets();
      if (!secrets) {
        error = "Your account keys aren't on this device. Sign in again with the account that made the event.";
        return;
      }
      const { orderKeysOf } = await import("../../keyring/order-keys.js");
      const { secretKeys } = await orderKeysOf(secrets);
      const r = await resendUndelivered(eventId, row.sessionId, to.trim(), secretKeys, buyerName.trim() || undefined);
      if (!r.ok) {
        // A box that will not open on this device: the account's keys moved on since
        // the sale (a passkey removed) and this device lacks that generation, or this
        // is another account altogether.
        error =
          r.code === "CANNOT_OPEN"
            ? auth.keyRingNotice
              ? "This device doesn't have your account's keys from when these tickets were sold. Resend from the device you used then, or reload to fetch your keys."
              : "This device can't open these tickets. Sign in with the account that made the event."
            : (r.error ?? "Couldn't resend the tickets.");
        return;
      }
      sent = { sessionId: row.sessionId, to: r.data?.sentTo ?? to.trim() };
      openFor = null;
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't confirm it's you.";
    } finally {
      sending = false;
    }
  }
</script>

{#if rows.length > 0 || sent}
  <div class="undelivered">
    {#if rows.length > 0}
      <div class="head">
        <strong>{rows.length === 1 ? "A ticket email didn't arrive" : `${rows.length} ticket emails didn't arrive`}</strong>
      </div>
      <p>
        The buyer doesn't have their ticket yet. When they get in touch, check them against the order, then send the
        same ticket to the address they give you. Only send to an address the buyer gave you.
      </p>
    {/if}

    {#if sent}
      <p class="ok">Sent to {sent.to}.</p>
    {/if}

    {#each rows as row (row.sessionId)}
      <div class="row">
        <div class="row-main">
          <span class="typed">{row.typedAddress ?? "Address not kept"}</span>
          <span class="meta">
            {row.editions.length === 1 ? `Ticket #${row.editions[0]}` : `Tickets ${row.editions.map((e) => `#${e}`).join(", ")}`}
            - {new Date(row.failedAt).toLocaleString()}
          </span>
          <span class="reason">{reasonText(row.reason)}</span>
        </div>

        {#if row.blocked}
          <p class="blocked">{BLOCKED[row.blocked] ?? "Can't be resent from here."}</p>
        {:else if row.resendsLeft === 0}
          <p class="blocked">These tickets have been resent the most times allowed. Contact WoCo support.</p>
        {:else if openFor === row.sessionId}
          <div class="form">
            <label class="field">
              <span>Buyer's email</span>
              <input type="email" bind:value={to} autocomplete="off" placeholder="the address the buyer gave you" />
            </label>
            <label class="field">
              <span>Name at the door (optional)</span>
              <input type="text" bind:value={buyerName} maxlength="100" autocomplete="off" />
            </label>
            <div class="actions">
              <button class="send-btn" onclick={() => resend(row)} disabled={sending || !looksMailable(to)}>
                {sending ? "Sending…" : looksMailable(to) ? `Send to ${to.trim()}` : "Send"}
              </button>
              <button class="cancel-btn" onclick={() => (openFor = null)} disabled={sending}>Cancel</button>
            </div>
            {#if error}<p class="alert" role="alert">{error}</p>{/if}
          </div>
        {:else}
          <button class="resend-btn" onclick={() => startResend(row.sessionId)}>Resend</button>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .undelivered {
    border: 1px solid var(--warning);
    background: var(--bg-surface);
    border-radius: var(--radius-md);
    padding: 1rem 1.25rem;
    margin: 0.75rem 0 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    font-size: 0.875rem;
    color: var(--text-secondary);
  }
  .undelivered p {
    margin: 0;
    line-height: 1.45;
  }
  .head strong {
    color: var(--warning);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 0.8125rem;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
  }
  .row-main {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }
  .typed {
    color: var(--text);
    font-family: var(--font-mono);
    overflow-wrap: anywhere;
  }
  .meta,
  .reason {
    font-size: 0.8125rem;
    color: var(--text-muted);
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: var(--text-secondary);
  }
  .field input {
    font-size: 0.875rem;
    padding: 0.5rem 0.625rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
  }
  .field input:focus {
    border-color: var(--border-focus);
    outline: none;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .send-btn,
  .resend-btn {
    align-self: flex-start;
    padding: 0.5rem 0.875rem;
    font-size: 0.8125rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: var(--accent-ink);
    max-width: 100%;
    overflow-wrap: anywhere;
    text-align: left;
  }
  .send-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .cancel-btn {
    padding: 0.5rem 0.75rem;
    font-size: 0.8125rem;
    color: var(--text-muted);
  }
  .blocked {
    font-size: 0.8125rem;
    color: var(--text-muted);
  }
  .alert {
    color: var(--error);
    font-size: 0.8125rem;
  }
  .ok {
    color: var(--success);
  }
</style>
