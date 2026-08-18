/**
 * `<woco-lap-count>` — a live lap count, at two sizes.
 *
 *   variant="overlay"  a bare figure for an OBS browser source, over video
 *   variant="card"     a self-contained card for a partner's own web page
 *
 * ONE ELEMENT, NOT TWO. The overlay, this widget and the public counter page
 * are the same artifact at three sizes; two elements would be two places for
 * the wording to drift, and the wording is the part of this rail that has to
 * hold. Every honesty decision lives in `display.ts` and is tested there — this
 * file paints what that module returns and adds nothing to it.
 *
 * WHY IT READS `/count` AND NOT `/manifest`. The verification page fetches the
 * manifest and recounts the leaves in the reader's browser, deliberately never
 * fetching `/count` alongside it: both come from one 30-second cache entry, so
 * comparing them cannot detect dishonesty and CAN manufacture a false mismatch
 * across a cache boundary. These two surfaces are the opposite case — they want
 * the figure, not the evidence, which is what `/count` exists to serve. The
 * evidence is one link away on the card, which is where a reader who wants it
 * should go.
 *
 * THE LINK LABEL IS THE COUNTER PAGE'S OWN PHRASE, not one invented here. That
 * page is the canonical artifact and this card is the same artifact at a
 * smaller size; two surfaces naming the evidence differently is precisely the
 * drift that makes a reader wonder whether they are two different things.
 *
 * LAPS, NOT LIKES. The format is fixed rather than exposed as an attribute: a
 * like tally and a lap tally need different explanations of what their evidence
 * proves, and one surface rendering either would say the wrong thing about one
 * of them.
 *
 * THE COASTER'S NAME IS NEVER HOST-SUPPLIED. It is resolved from the shared
 * subject registry, and a subject the registry does not define renders as the
 * registry's own self-labelling "Unknown coaster (0x…)". A free-text name
 * attribute would turn this element into a signage generator for coasters that
 * do not exist, publishing genuinely-signed entries under an invented identity
 * — the borrowed-authority hole the verification page closed by refusing
 * unknown subjects. A `challenge` kicker IS host-supplied, because a challenge
 * is the host's own event to name, but it is rendered ALONGSIDE the registry
 * name and never instead of it, so it cannot rename anything.
 */

import { WOCO_SUBJECTS, lookupSubject, currentEra, subjectDisplayName } from "@woco/shared/credit/registry";
import type { Hex0x } from "@woco/shared/types";
import {
  describe as describeCount,
  parseCountData,
  FLOOR_NOTE,
  type CountState,
} from "./display.js";
import { overlayStyles, cardStyles } from "./styles.js";

/** Laps. See the header — deliberately not an attribute. */
const FORMAT = "woco.credit.v1";

const SUBJECT_RE = /^0x[0-9a-f]{64}$/;

/** Where the public counter page lives, relative to the app. One constant so a
 *  change to that route is a one-line change here. */
const VERIFY_PATH = "/verify.html";

const DEFAULT_APP_URL = "https://woco.eth.limo";
const DEFAULT_API_URL = "https://events-api.woco-net.com";

/**
 * Seconds between reads. The counter caches a tally for 30 seconds and serves
 * `max-age=30`, so a shorter interval buys nothing and a much longer one makes
 * a stream feel dead. Worst honest staleness is roughly server cache + browser
 * cache + this interval.
 */
const DEFAULT_POLL_SECONDS = 20;

export class WocoLapCount extends HTMLElement {
  private shadow: ShadowRoot;
  private state: CountState = { kind: "pending" };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  /** Guards against a response from a previous subject painting over a new one. */
  private generation = 0;

  static get observedAttributes() {
    return ["subject", "api-url", "variant", "challenge", "theme", "app-url", "poll-seconds"];
  }

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this.stopped = false;
    this.render();
    document.addEventListener("visibilitychange", this.onVisibility);
    this.start();
  }

  disconnectedCallback() {
    this.stopped = true;
    this.clearTimer();
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  /**
   * Which attributes change WHICH count is being shown, as opposed to how it
   * looks. Only these discard what we already know: a number on screen was true
   * of the subject it was fetched for, so re-theming an overlay or renaming a
   * challenge mid-stream must not blank a live figure for a poll cycle. The
   * separation matters because the reset is the honest behaviour in one case
   * and a self-inflicted outage in the other.
   */
  private static readonly IDENTITY_ATTRS = new Set(["subject", "api-url"]);

  attributeChangedCallback(name: string) {
    // Fires once per attribute during initial parse, all before
    // connectedCallback — restarting then would run several polls against a
    // half-configured element.
    if (!this.isConnected) return;
    if (WocoLapCount.IDENTITY_ATTRS.has(name)) {
      this.state = { kind: "pending" };
      this.render();
      this.start();
      return;
    }
    this.render();
  }

  // -------------------------------------------------------------------------
  // Attributes
  // -------------------------------------------------------------------------

  private get subject(): string {
    return (this.getAttribute("subject") || "").trim().toLowerCase();
  }

  private get apiUrl(): string {
    return (this.getAttribute("api-url") || DEFAULT_API_URL).replace(/\/+$/, "");
  }

  private get variant(): "overlay" | "card" {
    return this.getAttribute("variant") === "card" ? "card" : "overlay";
  }

  private get theme(): "dark" | "light" {
    return this.getAttribute("theme") === "light" ? "light" : "dark";
  }

  private get challenge(): string {
    return (this.getAttribute("challenge") || "").trim();
  }

  private get pollSeconds(): number {
    const raw = Number(this.getAttribute("poll-seconds"));
    // A hostile or fat-fingered value must not turn a partner's page into a
    // request loop against one VM on the busiest day this rail will see.
    if (!Number.isFinite(raw) || raw < 10) return DEFAULT_POLL_SECONDS;
    return Math.min(raw, 600);
  }

  /**
   * Interpolated into an `href`, so it must be a scheme we chose — escaping
   * cannot help, since `javascript:…` contains no character an HTML escape
   * touches. Same guard and same reasoning as `woco-tickets.ts`.
   */
  private get appUrl(): string {
    const raw = this.getAttribute("app-url");
    if (!raw) return DEFAULT_APP_URL;
    try {
      const u = new URL(raw, window.location.href);
      if (u.protocol !== "http:" && u.protocol !== "https:") return DEFAULT_APP_URL;
      return u.href.replace(/\/+$/, "");
    } catch {
      return DEFAULT_APP_URL;
    }
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  private onVisibility = () => {
    if (document.hidden) {
      this.clearTimer();
      return;
    }
    // A backgrounded tab stops asking and asks again on return, so a partner's
    // page does not keep thousands of idle tabs polling one VM through a spike.
    if (!this.stopped) this.start();
  };

  private clearTimer() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private start() {
    this.clearTimer();
    if (this.stopped) return;
    const gen = ++this.generation;
    void this.poll(gen);
  }

  private schedule(gen: number) {
    this.clearTimer();
    if (this.stopped || document.hidden) return;
    // A chained timeout rather than an interval: a slow response must not let
    // requests pile up on top of each other.
    this.timer = setTimeout(() => void this.poll(gen), this.pollSeconds * 1000);
  }

  private async poll(gen: number) {
    if (gen !== this.generation) return;

    const data = await this.fetchCount();
    if (gen !== this.generation) return;

    if (data) {
      this.state = { kind: "known", data, consecutiveFailures: 0 };
    } else if (this.state.kind === "known") {
      // Keep the last honest number and count the failure — `display.ts` marks
      // it once the failures are sustained. A first-load failure stays PENDING,
      // because there is no number yet and zero is not a stand-in for one.
      this.state = { ...this.state, consecutiveFailures: this.state.consecutiveFailures + 1 };
    }

    this.render();
    this.schedule(gen);
  }

  private async fetchCount() {
    const subject = this.subject;
    if (!SUBJECT_RE.test(subject)) return null;

    const url =
      `${this.apiUrl}/api/social/count` +
      `?format=${encodeURIComponent(FORMAT)}&subject=${encodeURIComponent(subject)}`;

    try {
      // Plain fetch semantics on purpose. The response carries `max-age=30`,
      // and `no-store` here would defeat every cache between a viewer and the
      // one VM this runs on — which is the opposite of what a partner's
      // marketing page needs during a stream-day traffic spike.
      const resp = await fetch(url, { credentials: "omit" });
      if (!resp.ok) return null;
      // The body is not necessarily JSON even on a 200: a CDN error page and
      // this framework's plain-text 404 both arrive where JSON was expected,
      // and an unguarded parse would throw instead of counting as a failed read.
      const body: unknown = await resp.json().catch(() => null);
      if (typeof body !== "object" || body === null) return null;
      const env = body as { ok?: unknown; data?: unknown };
      if (env.ok !== true) return null;
      return parseCountData(env.data);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private esc(s: string): string {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /** The coaster and park, from the registry only. */
  private coasterLine(): string {
    const subject = this.subject;
    if (!SUBJECT_RE.test(subject)) return "";
    const def = lookupSubject(WOCO_SUBJECTS, subject as Hex0x);
    if (!def) return subjectDisplayName(WOCO_SUBJECTS, subject as Hex0x);
    const era = currentEra(def);
    return `${era.name} · ${era.park}`;
  }

  private verifyHref(): string {
    return `${this.appUrl}${VERIFY_PATH}?subject=${encodeURIComponent(this.subject)}`;
  }

  private render() {
    if (this.variant === "card") this.renderCard();
    else this.renderOverlay();
  }

  private renderOverlay() {
    const d = describeCount(this.state);
    const kicker = this.challenge || this.coasterLine();

    // Nothing at all before the first successful read: an overlay is composited
    // onto a broadcast, and a placeholder there is a graphic nobody chose.
    const figureHtml =
      d.figure === null
        ? ""
        : `<div class="figure"><span>${this.esc(d.figure)}</span><span class="unit">${this.esc(d.unit)}</span></div>`;

    const subParts: string[] = [];
    if (this.challenge && this.coasterLine()) {
      subParts.push(`<span class="coaster">${this.esc(this.coasterLine())}</span>`);
    }
    if (d.riders) subParts.push(`<span>${this.esc(d.riders)}</span>`);

    this.shadow.innerHTML = `
      <style>${overlayStyles()}</style>
      <div class="wrap${d.notUpdating ? " stale" : ""}">
        ${d.figure === null ? "" : `<div class="kicker">${this.esc(kicker)}</div>`}
        ${figureHtml}
        ${subParts.length ? `<div class="sub">${subParts.join('<span aria-hidden="true">·</span>')}</div>` : ""}
        <div class="stale-mark"><span class="dot"></span>not updating</div>
      </div>
    `;
  }

  private renderCard() {
    const d = describeCount(this.state);
    const kicker = this.challenge || this.coasterLine();
    const coaster = this.coasterLine();

    const figureHtml =
      d.figure === null
        ? `<div class="empty">Waiting for the counter…</div>`
        : `<div class="figure"><span>${this.esc(d.figure)}</span><span class="unit">${this.esc(d.unit)}</span></div>`;

    const subParts: string[] = [];
    if (this.challenge && coaster) subParts.push(this.esc(coaster));
    if (d.riders) subParts.push(this.esc(d.riders));

    this.shadow.innerHTML = `
      <style>${cardStyles(this.theme)}</style>
      <div class="wrap${d.notUpdating ? " stale" : ""}">
        ${kicker ? `<div class="kicker">${this.esc(kicker)}</div>` : ""}
        ${figureHtml}
        ${subParts.length ? `<div class="sub">${subParts.join(" · ")}</div>` : ""}
        ${d.line ? `<p class="line">${this.esc(d.line)}</p>` : ""}
        ${d.isFloor ? `<p class="note">${this.esc(FLOOR_NOTE)}</p>` : ""}
        <div class="stale-mark"><span class="dot"></span>Not updating — showing the last count we read.</div>
        ${
          SUBJECT_RE.test(this.subject)
            ? `<div class="actions"><a class="verify" href="${this.esc(this.verifyHref())}" target="_blank" rel="noopener noreferrer">See the working →</a></div>`
            : ""
        }
        <div class="mark">Counted by WoCo</div>
      </div>
    `;
  }
}
