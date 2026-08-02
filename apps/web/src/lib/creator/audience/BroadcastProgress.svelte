<script lang="ts">
  /**
   * Live state of a background broadcast.
   *
   * Deliberately NOT a progress bar with a percentage. An organiser knows how
   * big their list is; "83%" is the least useful number we could show them.
   * What they need is an account that always adds up — every person on the list
   * is, at any instant, in exactly one of four states, and the four counts sum
   * to the total. The bar underneath is the same four numbers in another form,
   * so it can never disagree with them.
   *
   * No spinner either. A spinner means "wait", and this is the one thing in the
   * app you do not have to wait for: the send outlives the tab.
   */
  import {
    cancelBroadcastJob,
    isBroadcastFinished,
    type BroadcastJobStatus,
  } from "../../api/broadcasts.js";

  interface Props {
    job: BroadcastJobStatus;
    /** Fired when the organiser asks to mail the people who were missed. */
    onResume?: (job: BroadcastJobStatus) => void;
    onDismiss?: () => void;
  }

  let { job, onResume, onDismiss }: Props = $props();

  let cancelling = $state(false);
  let cancelError = $state<string | null>(null);
  /** One resume per finished job. A second click would mail the remainder twice. */
  let resuming = $state(false);

  const finished = $derived(isBroadcastFinished(job));
  const total = $derived(Math.max(job.accepted, 1));

  /** Width as a fraction of the accepted total — never rounded up to look full. */
  const pct = (n: number) => `${(n / total) * 100}%`;

  const headline = $derived.by(() => {
    switch (job.state) {
      case "queued":
        return `Queued for ${job.accepted.toLocaleString()} ${people(job.accepted)}`;
      case "running":
        return `Sending to ${job.accepted.toLocaleString()} ${people(job.accepted)}`;
      case "completed":
        return job.failed > 0
          ? `Sent to ${job.sent.toLocaleString()} of ${job.accepted.toLocaleString()}`
          : `Sent to ${job.sent.toLocaleString()} ${people(job.sent)}`;
      case "cancelled":
        return "Stopped";
      case "died":
        return "Stopped before it finished";
      case "expired":
        return "Ran out of time";
      default:
        return "Preparing";
    }
  });

  function people(n: number): string {
    return n === 1 ? "person" : "people";
  }

  /**
   * The recovery line. Written as an instruction, not an apology — the
   * organiser needs to know what to do next, and `reason` comes from the server
   * already phrased for them.
   */
  const guidance = $derived.by(() => {
    if (job.state === "running" || job.state === "queued") {
      return "You can close this page — the send carries on without it.";
    }
    if (job.state === "cancelled") {
      return `${job.sent.toLocaleString()} had already gone out and can't be recalled.`;
    }
    if (job.reason) return job.reason;
    if (job.state === "completed" && job.failed > 0) {
      return `${job.failed.toLocaleString()} couldn't be delivered.`;
    }
    return null;
  });

  const missed = $derived(Math.max(0, job.accepted - job.sent - job.suppressed));

  async function stop(): Promise<void> {
    cancelError = null;
    if (!confirm(`Stop this send? ${job.sent.toLocaleString()} already sent can't be recalled.`)) {
      return;
    }
    cancelling = true;
    try {
      job = await cancelBroadcastJob(job.jobId);
    } catch (err) {
      cancelError = err instanceof Error ? err.message : "Couldn't stop the send.";
    } finally {
      cancelling = false;
    }
  }
</script>

<section class="broadcast" class:is-live={!finished} aria-live="polite">
  <header>
    <h4>{headline}</h4>
    {#if !finished}
      <span class="pulse" aria-hidden="true"></span>
    {/if}
  </header>

  <!--
    The ledger. Four dispositions that sum to the accepted total, so the
    organiser can always account for every contact. Tabular figures keep the
    digits from jittering as they count.
  -->
  <dl class="ledger">
    <div class="entry sent">
      <dt>Sent</dt>
      <dd>{job.sent.toLocaleString()}</dd>
    </div>
    <div class="entry skipped" class:zero={job.suppressed === 0}>
      <dt>Unsubscribed</dt>
      <dd>{job.suppressed.toLocaleString()}</dd>
    </div>
    <div class="entry failed" class:zero={job.failed === 0}>
      <dt>Failed</dt>
      <dd>{job.failed.toLocaleString()}</dd>
    </div>
    <div class="entry left" class:zero={job.remaining === 0}>
      <dt>{finished ? "Not sent" : "To go"}</dt>
      <dd>{job.remaining.toLocaleString()}</dd>
    </div>
  </dl>

  <div
    class="bar"
    role="progressbar"
    aria-valuemin="0"
    aria-valuemax={job.accepted}
    aria-valuenow={job.sent}
    aria-label="Delivered so far"
  >
    <span class="seg seg-sent" style:width={pct(job.sent)}></span>
    <span class="seg seg-skipped" style:width={pct(job.suppressed)}></span>
    <span class="seg seg-failed" style:width={pct(job.failed)}></span>
  </div>

  {#if guidance}
    <p class="guidance" class:warn={job.state === "died" || job.state === "expired"}>
      {guidance}
    </p>
  {/if}

  {#if job.skipped > 0}
    <p class="aside">
      {job.skipped.toLocaleString()} already had this email and were left out.
    </p>
  {/if}

  {#if cancelError}<p class="aside err">{cancelError}</p>{/if}

  <footer>
    {#if !finished}
      <button type="button" class="btn-ghost" onclick={stop} disabled={cancelling}>
        {cancelling ? "Stopping…" : "Stop sending"}
      </button>
    {:else}
      {#if job.resumable && missed > 0 && onResume}
        <button
          type="button"
          class="btn-primary"
          disabled={resuming}
          onclick={() => { resuming = true; onResume(job); }}
        >
          {resuming ? "Starting…" : `Send to the ${missed.toLocaleString()} who missed it`}
        </button>
      {/if}
      {#if onDismiss}
        <button type="button" class="btn-ghost" onclick={onDismiss}>Done</button>
      {/if}
    {/if}
  </footer>
</section>

<style>
  .broadcast {
    display: grid;
    gap: 0.875rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    padding: 1rem;
  }
  .broadcast.is-live { border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }

  header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  h4 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 0.9375rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text);
  }

  /* The only motion here: a slow breath that says "still going", where a
     spinner would say "wait for me". */
  .pulse {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    animation: breathe 1.8s ease-in-out infinite;
  }
  @keyframes breathe {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.25; }
  }

  .ledger {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.75rem;
    margin: 0;
  }
  .entry { display: grid; gap: 0.125rem; }
  .entry dt {
    font-size: 0.6875rem;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .entry dd {
    margin: 0;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: 1.25rem;
    line-height: 1.1;
    color: var(--text);
  }
  .entry.sent dd { color: var(--accent-text); }
  .entry.failed:not(.zero) dd { color: var(--error); }
  /* A count of zero is the good outcome, so it recedes rather than shouting. */
  .entry.zero dt,
  .entry.zero dd { color: var(--text-dim); }

  .bar {
    display: flex;
    height: 3px;
    border-radius: 999px;
    background: var(--bg-input);
    overflow: hidden;
  }
  .seg { transition: width var(--transition); }
  .seg-sent { background: var(--accent); }
  /* Unsubscribed is correct behaviour, not a fault — it reads as neutral. */
  .seg-skipped { background: var(--text-dim); }
  .seg-failed { background: var(--error); }

  .guidance {
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.5;
    color: var(--text-secondary);
  }
  .guidance.warn { color: var(--warning); }

  .aside {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .aside.err { color: var(--error); }

  footer {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }
  footer:empty { display: none; }

  .btn-primary {
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 700;
    font-size: 0.8125rem;
    padding: 0.5rem 0.875rem;
    border-radius: var(--radius-md);
    transition: background var(--transition);
  }
  .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-ghost {
    border: 1px solid var(--border);
    color: var(--text-secondary);
    font-size: 0.8125rem;
    padding: 0.5rem 0.875rem;
    border-radius: var(--radius-md);
    transition: border-color var(--transition), color var(--transition);
  }
  .btn-ghost:hover:not(:disabled) { border-color: var(--border-hover); color: var(--text); }
  .btn-ghost:disabled { opacity: 0.4; cursor: not-allowed; }

  @media (max-width: 30rem) {
    .ledger { grid-template-columns: repeat(2, 1fr); gap: 0.625rem 0.75rem; }
  }

  @media (prefers-reduced-motion: reduce) {
    .pulse { animation: none; }
    .seg { transition: none; }
  }
</style>
