<script lang="ts">
  import type { MarketingContact } from "@woco/shared";
  import { checkMarketingEmails } from "../../api/marketing.js";

  interface Props {
    existingEmails: Set<string>;
    busy: boolean;
    onCommit: (added: MarketingContact[]) => Promise<void>;
    onCancel: () => void;
  }

  let { existingEmails, busy, onCommit, onCancel }: Props = $props();

  type Step = "pick" | "map" | "report";
  let step = $state<Step>("pick");
  let parsing = $state(false);
  let error = $state<string | null>(null);

  let fileName = $state("");
  let headers = $state<string[]>([]);
  let rows = $state<Record<string, string>[]>([]);

  // Column mapping: field → header name (or "" = not mapped)
  type Field = "email" | "firstName" | "lastName" | "postcode" | "dob";
  let mapping = $state<Record<Field, string>>({ email: "", firstName: "", lastName: "", postcode: "", dob: "" });

  // Validation report
  let checking = $state(false);
  let candidates = $state<MarketingContact[]>([]);
  let invalidRows = $state(0);
  let dupesInFile = $state(0);
  let dupesVsList = $state(0);
  let suppressedCount = $state(0);
  let suppressedSet = $state<Set<string>>(new Set());
  let warrantyTicked = $state(false);

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const FIELD_HEURISTICS: Record<Field, RegExp> = {
    email: /^e-?mail(address)?$/,
    firstName: /^(first(name)?|given(name)?|forename)$/,
    lastName: /^(last(name)?|surname|family(name)?)$/,
    postcode: /^(post(al)?code|zip(code)?)$/,
    dob: /^(dob|dateofbirth|birth(date|day)?)$/,
  };

  function normHeader(h: string): string {
    return h.toLowerCase().replace(/[\s_.-]/g, "");
  }

  function autoMap(hdrs: string[]): void {
    const next: Record<Field, string> = { email: "", firstName: "", lastName: "", postcode: "", dob: "" };
    for (const h of hdrs) {
      const n = normHeader(h);
      for (const field of Object.keys(FIELD_HEURISTICS) as Field[]) {
        if (!next[field] && FIELD_HEURISTICS[field].test(n)) next[field] = h;
      }
    }
    mapping = next;
  }

  async function handleFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    error = null;
    parsing = true;
    fileName = file.name;
    try {
      // papaparse loads lazily — it only ever ships to organisers who import
      const Papa = (await import("papaparse")).default;
      await new Promise<void>((resolve, reject) => {
        Papa.parse<Record<string, string>>(file, {
          header: true,
          skipEmptyLines: true,
          complete: (res) => {
            headers = (res.meta.fields ?? []).filter(Boolean);
            rows = res.data;
            resolve();
          },
          error: (err) => reject(err),
        });
      });
      if (headers.length === 0 || rows.length === 0) {
        error = "That file has no rows we can read. Export a CSV with a header row and try again.";
        return;
      }
      autoMap(headers);
      step = "map";
    } catch (err) {
      error = err instanceof Error ? err.message : "Could not read that file.";
    } finally {
      parsing = false;
      input.value = "";
    }
  }

  async function buildReport(): Promise<void> {
    if (!mapping.email) {
      error = "Choose which column holds the email address.";
      return;
    }
    error = null;
    checking = true;
    try {
      const addedAt = new Date().toISOString();
      const source = `csv:${fileName}`;
      const seen = new Set<string>();
      const fresh: MarketingContact[] = [];
      let invalid = 0;
      let dupFile = 0;
      let dupList = 0;

      for (const row of rows) {
        const raw = (row[mapping.email] ?? "").trim().toLowerCase();
        if (!EMAIL_RE.test(raw)) { invalid++; continue; }
        if (seen.has(raw)) { dupFile++; continue; }
        seen.add(raw);
        if (existingEmails.has(raw)) { dupList++; continue; }
        const pick = (f: Field) => (mapping[f] ? (row[mapping[f]] ?? "").trim() || undefined : undefined);
        fresh.push({
          email: raw,
          firstName: pick("firstName"),
          lastName: pick("lastName"),
          postcode: pick("postcode"),
          dob: pick("dob"),
          source,
          addedAt,
        });
      }

      invalidRows = invalid;
      dupesInFile = dupFile;
      dupesVsList = dupList;

      if (fresh.length === 0) {
        candidates = [];
        suppressedCount = 0;
        suppressedSet = new Set();
      } else {
        const res = await checkMarketingEmails(fresh.map((c) => c.email));
        suppressedSet = new Set(res.suppressed);
        suppressedCount = res.suppressed.length;
        candidates = fresh;
      }
      warrantyTicked = false;
      step = "report";
    } catch (err) {
      error = err instanceof Error ? err.message : "Validation failed.";
    } finally {
      checking = false;
    }
  }

  const willImport = $derived(candidates.length);
  const willNeverReceive = $derived(suppressedCount);

  async function commit(): Promise<void> {
    if (!warrantyTicked || candidates.length === 0) return;
    error = null;
    try {
      // Suppressed contacts ARE imported (they may be in the list for records)
      // but the suppression list guarantees they are never emailed.
      await onCommit(candidates);
    } catch (err) {
      error = err instanceof Error ? err.message : "Import failed.";
    }
  }
</script>

<section class="wizard" aria-label="Import contacts">
  <header class="wiz-head">
    <span class="wiz-step">{step === "pick" ? "1" : step === "map" ? "2" : "3"} / 3</span>
    <h3>
      {#if step === "pick"}Import contacts{:else if step === "map"}Match your columns{:else}Review before import{/if}
    </h3>
    <button class="wiz-close" onclick={onCancel} aria-label="Close import">✕</button>
  </header>

  {#if step === "pick"}
    <p class="hint">
      Upload the customer CSV you exported from Skiddle, Fatsoma, RA or any other platform.
      Only contacts who opted in to hear from <em>you</em> belong here.
    </p>
    <button class="drop" onclick={() => document.getElementById("csv-input")?.click()} disabled={parsing}>
      <span class="drop-icon">{parsing ? "⋯" : "+"}</span>
      <span class="drop-text">{parsing ? "Reading file…" : "Choose a CSV file"}</span>
    </button>
    <input id="csv-input" type="file" accept=".csv,text/csv" onchange={handleFile} hidden disabled={parsing} />

  {:else if step === "map"}
    <p class="hint">From <strong>{fileName}</strong> — {rows.length.toLocaleString()} rows. We matched what we could; adjust if needed.</p>
    <div class="map-grid">
      {#each [["email", "Email (required)"], ["firstName", "First name"], ["lastName", "Last name"], ["postcode", "Postcode"], ["dob", "Date of birth"]] as [field, label] (field)}
        <label class="map-row" class:unmapped={field === "email" && !mapping.email}>
          <span class="map-label">{label}</span>
          <select bind:value={mapping[field as Field]}>
            <option value="">— not in this file —</option>
            {#each headers as h (h)}
              <option value={h}>{h}</option>
            {/each}
          </select>
        </label>
      {/each}
    </div>
    <div class="wiz-actions">
      <button class="btn-ghost" onclick={() => (step = "pick")}>Back</button>
      <button class="btn-primary" onclick={() => void buildReport()} disabled={checking || !mapping.email}>
        {checking ? "Checking…" : "Check contacts"}
      </button>
    </div>

  {:else}
    <!-- The manifest: every number is a promise the platform keeps -->
    <div class="manifest">
      <div class="tally lead">
        <span class="tally-n">{willImport.toLocaleString()}</span>
        <span class="tally-l">new contacts will be added</span>
      </div>
      {#if willNeverReceive > 0}
        <div class="tally hold">
          <span class="tally-n">{willNeverReceive.toLocaleString()}</span>
          <span class="tally-l">previously unsubscribed — imported for your records, but they will <strong>never</strong> be emailed. Their unsubscribe stands.</span>
        </div>
      {/if}
      {#if dupesVsList > 0}
        <div class="tally">
          <span class="tally-n">{dupesVsList.toLocaleString()}</span>
          <span class="tally-l">already in your audience — skipped, no duplicates</span>
        </div>
      {/if}
      {#if dupesInFile > 0}
        <div class="tally">
          <span class="tally-n">{dupesInFile.toLocaleString()}</span>
          <span class="tally-l">duplicate rows in the file — merged</span>
        </div>
      {/if}
      {#if invalidRows > 0}
        <div class="tally">
          <span class="tally-n">{invalidRows.toLocaleString()}</span>
          <span class="tally-l">rows without a valid email — skipped</span>
        </div>
      {/if}
    </div>

    {#if willImport > 0}
      <!-- The legal moment: deliberate, not a buried tickbox -->
      <label class="warranty" class:ticked={warrantyTicked}>
        <input type="checkbox" bind:checked={warrantyTicked} />
        <span class="warranty-box" aria-hidden="true"></span>
        <span class="warranty-text">
          <strong>I confirm these contacts gave consent to receive marketing from me</strong>
          — they opted in on the platform I exported them from, and I am their data
          controller. WoCo processes this list on my instructions.
        </span>
      </label>
    {:else}
      <p class="hint">Nothing new to import from this file.</p>
    {/if}

    <div class="wiz-actions">
      <button class="btn-ghost" onclick={() => (step = "map")}>Back</button>
      <button class="btn-primary" onclick={() => void commit()} disabled={!warrantyTicked || willImport === 0 || busy}>
        {busy ? "Encrypting & saving…" : `Add ${willImport.toLocaleString()} contact${willImport === 1 ? "" : "s"}`}
      </button>
    </div>
  {/if}

  {#if error}<p class="wiz-error">{error}</p>{/if}
</section>

<style>
  .wizard {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-surface);
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .wiz-head {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .wiz-step {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    color: var(--accent-text);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.2rem 0.45rem;
    white-space: nowrap;
  }

  .wiz-head h3 {
    font-family: var(--font-display);
    font-size: 1rem;
    margin: 0;
    flex: 1;
  }

  .wiz-close {
    color: var(--text-muted);
    font-size: 0.875rem;
    padding: 0.25rem 0.5rem;
    transition: color var(--transition);
  }
  .wiz-close:hover { color: var(--text); }

  .hint {
    color: var(--text-muted);
    font-size: 0.8125rem;
    line-height: 1.5;
    margin: 0;
  }
  .hint em { color: var(--text-secondary); font-style: normal; font-weight: 600; }

  .drop {
    width: 100%;
    padding: 2.5rem 1rem;
    border: 2px dashed var(--border);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    transition: border-color var(--transition), background var(--transition);
  }
  .drop:hover { border-color: var(--accent); background: var(--accent-subtle); }
  .drop-icon { font-size: 1.5rem; color: var(--text-muted); font-weight: 300; }
  .drop-text { color: var(--text-muted); font-size: 0.875rem; }
  .drop:hover .drop-icon, .drop:hover .drop-text { color: var(--accent-text); }

  .map-grid { display: flex; flex-direction: column; gap: 0.5rem; }

  .map-row {
    display: grid;
    grid-template-columns: 9.5rem 1fr;
    align-items: center;
    gap: 0.75rem;
  }

  .map-row.unmapped .map-label { color: var(--warning); }

  .map-label { font-size: 0.8125rem; color: var(--text-secondary); }

  .map-row select {
    background: var(--bg-input);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 0.5rem 0.625rem;
    font-size: 0.8125rem;
    width: 100%;
    transition: border-color var(--transition);
  }
  .map-row select:focus { border-color: var(--accent); outline: none; }

  /* ── The manifest ─────────────────────────────────────────────────────── */
  .manifest {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .tally {
    display: grid;
    grid-template-columns: 5rem 1fr;
    gap: 0.75rem;
    align-items: baseline;
    padding: 0.75rem 1rem;
    background: var(--bg);
  }
  .tally + .tally { border-top: 1px solid var(--border); }

  .tally-n {
    font-family: var(--font-mono);
    font-size: 1.125rem;
    text-align: right;
    color: var(--text-muted);
  }

  .tally-l { font-size: 0.8125rem; color: var(--text-muted); line-height: 1.45; }

  .tally.lead .tally-n { color: var(--accent); font-size: 1.375rem; }
  .tally.lead .tally-l { color: var(--text); }

  .tally.hold { background: var(--accent-subtle); }
  .tally.hold .tally-n { color: var(--accent-text); }
  .tally.hold .tally-l { color: var(--text-secondary); }
  .tally.hold strong { color: var(--accent-text); }

  /* ── The warranty (legal moment) ──────────────────────────────────────── */
  .warranty {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.875rem;
    padding: 1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: border-color var(--transition), background var(--transition);
  }
  .warranty:hover { border-color: var(--border-hover); }
  .warranty.ticked { border-color: var(--accent); background: var(--accent-subtle); }

  .warranty input { position: absolute; opacity: 0; pointer-events: none; }

  .warranty-box {
    width: 22px;
    height: 22px;
    margin-top: 1px;
    border: 2px solid var(--border-hover);
    border-radius: var(--radius-sm);
    position: relative;
    transition: border-color var(--transition), background var(--transition);
  }
  .warranty.ticked .warranty-box { background: var(--accent); border-color: var(--accent); }
  .warranty.ticked .warranty-box::after {
    content: "";
    position: absolute;
    left: 6px;
    top: 1px;
    width: 5px;
    height: 11px;
    border: solid var(--accent-ink);
    border-width: 0 2.5px 2.5px 0;
    transform: rotate(45deg);
  }
  .warranty input:focus-visible + .warranty-box {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .warranty-text {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    line-height: 1.55;
  }
  .warranty-text strong { color: var(--text); }

  .wiz-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }

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

  .wiz-error { color: var(--error); font-size: 0.8125rem; margin: 0; }
</style>
