import { createApiClient, type ApiClient } from "../api/client.js";
import { getStyles } from "./styles.js";
import {
  sealJson,
  calculateBuyerFees,
  MARKETING_CONSENT_NOTICE,
  TRANSACTIONAL_EMAIL_NOTICE,
  CHECKOUT_PRIVACY_SUMMARY,
  type OrderField,
  type PaymentConfig,
  type SealedBox,
} from "@woco/shared";
import { cacheGet, cacheSet, TTL_7D, embedCacheKey } from "../cache.js";
import {
  MAX_QTY,
  seriesPayable,
  validateEmail,
  maxSelectableQty,
  buildOrderPayload,
  buildCheckoutBody,
  reserveOutcome,
} from "../checkout.js";

interface SeriesSummary {
  seriesId: string;
  name: string;
  description: string;
  totalSupply: number;
  payment?: PaymentConfig;
}

interface EventData {
  eventId: string;
  title: string;
  description: string;
  imageHash: string;
  location: string;
  startDate: string;
  series: SeriesSummary[];
  encryptionKey?: string;
  orderFields?: OrderField[];
}

interface ClaimStatus {
  seriesId: string;
  totalSupply: number;
  claimed: number;
  available: number;
}

interface SeriesState {
  status: ClaimStatus | null;
  /** Reserve + checkout-session round-trip in flight (ends in navigation). */
  busy: boolean;
  error: string | null;
  /** Buy panel expanded (order form + email + quantity + consent). */
  buyOpen: boolean;
  quantity: number;
  /** Email + consent live in state, not just the DOM: a quantity change
   *  re-renders the card to refresh the total, which would otherwise wipe
   *  what the buyer already typed/ticked. */
  email: string;
  consent: boolean;
  orderFormData: Record<string, string>;
}

export class WocoTickets extends HTMLElement {
  private api: ApiClient | null = null;
  private event: EventData | null = null;
  private seriesStates: Map<string, SeriesState> = new Map();
  private shadow: ShadowRoot;
  private delegationSetup = false;

  static get observedAttributes() {
    return ["event-id", "api-url", "theme", "show-image", "show-description"];
  }

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this.render();
    if (!this.delegationSetup) {
      this.setupDelegation();
      this.delegationSetup = true;
    }
    this.loadEvent();
  }

  attributeChangedCallback() {
    // Only reload when already in the DOM — attributeChangedCallback fires once per
    // attribute during initial parse, all before connectedCallback. Without this
    // guard, concurrent loadEvent() calls race and reset state mid-interaction.
    if (this.isConnected) this.loadEvent();
  }

  private get eventId() { return this.getAttribute("event-id") || ""; }
  private get apiUrl() { return this.getAttribute("api-url") || ""; }
  /** Where the hosted legal pages live. Overridable for self-hosted deployments. */
  private static readonly DEFAULT_APP_URL = "https://woco.eth.limo";

  /**
   * Host-page-supplied, so it is interpolated into an `href` and must be a
   * scheme we chose. Escaping cannot help here — `javascript:alert(1)` contains
   * no character `esc()` touches. Allow only http(s) and fall back to the
   * canonical app otherwise.
   *
   * The host page is already fully privileged on its own page, so this is not a
   * privilege boundary. It is here so the widget cannot be turned into the
   * instrument of an injection against a buyer mid-purchase.
   */
  private get appUrl(): string {
    const raw = this.getAttribute("app-url");
    if (!raw) return WocoTickets.DEFAULT_APP_URL;
    try {
      const u = new URL(raw, window.location.href);
      if (u.protocol !== "http:" && u.protocol !== "https:") return WocoTickets.DEFAULT_APP_URL;
      return u.href.replace(/\/+$/, "");
    } catch {
      return WocoTickets.DEFAULT_APP_URL;
    }
  }
  private get theme() { return (this.getAttribute("theme") || "dark") as "dark" | "light"; }
  private get showImage() { return this.getAttribute("show-image") !== "false"; }
  private get showDescription() { return this.getAttribute("show-description") !== "false"; }

  private freshSeriesState(status: ClaimStatus | null = null): SeriesState {
    return {
      status,
      busy: false,
      error: null,
      buyOpen: false,
      quantity: 1,
      email: "",
      consent: false,
      orderFormData: {},
    };
  }

  private async loadEvent() {
    if (!this.eventId || !this.apiUrl) return;

    this.api = createApiClient(this.apiUrl);

    // ------------------------------------------------------------------
    // 1. Show cached event immediately — eliminates loading state on
    //    return visits. Render with cached statuses if available.
    // ------------------------------------------------------------------
    const evKey = embedCacheKey.event(this.eventId);
    const cachedEvent = cacheGet<EventData>(evKey);

    if (cachedEvent) {
      this.event = cachedEvent;
      for (const s of cachedEvent.series) {
        const stKey = embedCacheKey.claimStatus(this.eventId, s.seriesId);
        this.seriesStates.set(s.seriesId, this.freshSeriesState(cacheGet<ClaimStatus>(stKey)));
      }
      this.render(); // Instant render from cache
    } else {
      this.renderLoading();
    }

    // ------------------------------------------------------------------
    // 2. Always fetch fresh in the background — silently patches the
    //    rendered widget if event data or availability counts changed.
    // ------------------------------------------------------------------
    try {
      const resp = await this.api.get<EventData>(`/api/events/${this.eventId}`);
      if (!resp.ok || !resp.data) {
        if (!cachedEvent) this.renderError("Event not found");
        return;
      }
      const freshEvent = resp.data;
      cacheSet(evKey, freshEvent, TTL_7D);
      this.event = freshEvent;

      // Fetch claim statuses in parallel
      const statuses = await Promise.all(
        freshEvent.series.map(async (s) => {
          try {
            const r = await this.api!.get<ClaimStatus>(
              `/api/events/${this.eventId}/series/${s.seriesId}/claim-status`,
            );
            const st = r.data ?? null;
            if (st) cacheSet(embedCacheKey.claimStatus(this.eventId, s.seriesId), st, TTL_7D);
            return st;
          } catch {
            return null;
          }
        }),
      );

      // Merge fresh statuses — preserve any in-progress buyer state
      for (let i = 0; i < freshEvent.series.length; i++) {
        const sid = freshEvent.series[i].seriesId;
        const existing = this.seriesStates.get(sid);
        this.seriesStates.set(sid, {
          ...(existing ?? this.freshSeriesState()),
          status: statuses[i],
        });
      }

      // Re-render silently — only if not mid-interaction
      if (!this.isUserInteracting()) {
        this.render();
      }
    } catch {
      if (!cachedEvent) this.renderError("Failed to load event");
      // Cached data stays shown — background failure is silent
    }
  }

  /** Returns true if the user has an active buy panel open in any series card. */
  private isUserInteracting(): boolean {
    for (const [, st] of this.seriesStates) {
      if (st.busy || st.buyOpen) return true;
    }
    return false;
  }

  private renderLoading() {
    this.shadow.innerHTML = `
      <style>${getStyles(this.theme)}</style>
      <div class="woco-container">
        <div class="loading">Loading event...</div>
      </div>
    `;
  }

  private renderError(msg: string) {
    this.shadow.innerHTML = `
      <style>${getStyles(this.theme)}</style>
      <div class="woco-container">
        <div class="error-msg">${this.esc(msg)}</div>
      </div>
    `;
  }

  private render() {
    if (!this.event) {
      this.renderLoading();
      return;
    }

    const ev = this.event;
    const beeGw = "https://gateway.woco-net.com";
    const imgSrc = this.showImage && ev.imageHash ? `${beeGw}/bytes/${ev.imageHash}` : "";

    let seriesHtml = "";
    for (const s of ev.series) {
      const st = this.seriesStates.get(s.seriesId);
      seriesHtml += this.renderSeries(s, st);
    }

    const descHtml = this.showDescription && ev.description
      ? `<p class="woco-desc">${this.esc(ev.description)}</p>`
      : "";

    this.shadow.innerHTML = `
      <style>${getStyles(this.theme)}</style>
      <div class="woco-container">
        <div class="woco-header">
          ${imgSrc ? `<img src="${this.esc(imgSrc)}" alt="${this.esc(ev.title)}" />` : ""}
          <div>
            <h2>${this.esc(ev.title)}</h2>
            ${ev.location ? `<p>${this.esc(ev.location)}</p>` : ""}
          </div>
        </div>
        ${descHtml}
        ${seriesHtml}
        <div class="powered-by">Powered by WoCo</div>
      </div>
    `;
  }

  /** Replace only the series card for the given seriesId — no full shadow DOM rebuild. */
  private updateSeries(seriesId: string) {
    const s = this.event?.series.find((s) => s.seriesId === seriesId);
    if (!s) return;
    const st = this.seriesStates.get(seriesId);
    const existing = this.shadow.querySelector(`[data-series="${CSS.escape(seriesId)}"]`);
    if (!existing) {
      this.render();
      return;
    }
    const tmp = document.createElement("div");
    tmp.innerHTML = this.renderSeries(s, st);
    const newEl = tmp.firstElementChild;
    if (newEl) existing.replaceWith(newEl);
  }

  /** Attach delegated event listeners once on the shadow root — survive innerHTML resets. */
  private setupDelegation() {
    this.shadow.addEventListener("click", (e) => {
      const target = e.target as Element;

      // data-buy — expand the buy panel
      const buyBtn = target.closest<HTMLElement>("[data-buy]");
      if (buyBtn) {
        const sid = buyBtn.getAttribute("data-buy")!;
        const st = this.seriesStates.get(sid);
        if (st) {
          st.buyOpen = true;
          st.error = null;
          this.updateSeries(sid);
        }
        return;
      }

      // data-checkout — reserve + create the Stripe session + redirect
      const checkoutBtn = target.closest<HTMLElement>("[data-checkout]");
      if (checkoutBtn) {
        this.handleCheckout(checkoutBtn.getAttribute("data-checkout")!);
        return;
      }

      // data-cancel-order — collapse and reset the buy panel
      const cancelOrderBtn = target.closest<HTMLElement>("[data-cancel-order]");
      if (cancelOrderBtn) {
        const sid = cancelOrderBtn.getAttribute("data-cancel-order")!;
        const st = this.seriesStates.get(sid);
        if (st) {
          st.buyOpen = false;
          st.orderFormData = {};
          st.email = "";
          st.consent = false;
          st.quantity = 1;
          st.error = null;
          this.updateSeries(sid);
        }
        return;
      }
    });

    // Field sync — update state without re-rendering (a re-render would drop focus)
    this.shadow.addEventListener("input", (e) => {
      const el = e.target as HTMLElement;
      const emailAttr = el.getAttribute("data-email-input");
      if (emailAttr && el instanceof HTMLInputElement) {
        const st = this.seriesStates.get(emailAttr);
        if (st) st.email = el.value;
        return;
      }
      const attr = el.getAttribute("data-order-field");
      if (!attr) return;
      const [sid, fieldId] = attr.split(":");
      const st = this.seriesStates.get(sid);
      if (!st) return;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        st.orderFormData[fieldId] = el.value;
      }
    });

    this.shadow.addEventListener("change", (e) => {
      const el = e.target as HTMLElement;

      // Quantity changes the total, so this one re-renders the card. Email and
      // consent survive because they are read back out of state.
      const qtyAttr = el.getAttribute("data-qty-select");
      if (qtyAttr && el instanceof HTMLSelectElement) {
        const st = this.seriesStates.get(qtyAttr);
        if (st) {
          const q = parseInt(el.value, 10);
          st.quantity = Number.isInteger(q) && q >= 1 && q <= MAX_QTY ? q : 1;
          this.updateSeries(qtyAttr);
        }
        return;
      }

      const consentAttr = el.getAttribute("data-marketing-consent");
      if (consentAttr && el instanceof HTMLInputElement) {
        const st = this.seriesStates.get(consentAttr);
        if (st) st.consent = el.checked;
        return;
      }

      const attr = el.getAttribute("data-order-field");
      if (!attr) return;
      const [sid, fieldId] = attr.split(":");
      const st = this.seriesStates.get(sid);
      if (!st) return;
      if (el instanceof HTMLInputElement && el.type === "checkbox") {
        st.orderFormData[fieldId] = el.checked ? "yes" : "";
      }
    });
  }

  /**
   * Point-of-collection notice + marketing opt-in.
   *
   * The widget runs on the ORGANISER'S domain, where the buyer has never seen a
   * WoCo page — so the disclosure and the PECR opt-out have to travel with the
   * form. Wording is kept byte-identical to the main checkout (shared/legal
   * consent.ts) because the server stores it as Art. 7(1) evidence — the two
   * surfaces must not drift, so both read the same shared constants.
   */
  private renderConsent(seriesId: string, st: SeriesState): string {
    return `
      <div class="consent-block">
        <div class="transactional-note">${this.esc(TRANSACTIONAL_EMAIL_NOTICE)}</div>
        <label class="consent-row">
          <input type="checkbox" data-marketing-consent="${this.esc(seriesId)}" ${st.consent ? "checked" : ""} />
          <span>${this.esc(MARKETING_CONSENT_NOTICE)}</span>
        </label>
        <div class="privacy-note">
          ${this.esc(CHECKOUT_PRIVACY_SUMMARY)}
          <a href="${this.esc(this.appUrl)}/#/legal/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>
        </div>
      </div>
    `;
  }

  private get hasOrderForm(): boolean {
    return !!(this.event?.orderFields?.length && this.event?.encryptionKey);
  }

  /** True when this series can actually be sold here: Stripe rail on, price > 0. */
  private isPayable(s: SeriesSummary): boolean {
    return seriesPayable(s.payment);
  }

  private renderOrderFields(seriesId: string, st: SeriesState): string {
    const fields = this.event?.orderFields ?? [];
    let fieldsHtml = "";

    // `maxlength` is interpolated RAW into a double-quoted attribute below, so
    // escaping is not enough — coerce, because the value is not trustworthy.
    // `OrderField.maxLength` is typed `number?` but that is a COMPILE-TIME claim
    // about our own code; the value arrives as JSON from the event manifest and
    // the server never validates orderFields (it destructures and passes the
    // array straight through — apps/server/src/routes/events.ts, whose
    // validation block covers title/dates/tags/geo/payment only). A crafted
    // event carrying `maxLength: '1" onfocus="…'` would otherwise break out of
    // the attribute. Emitting it only when it really is a positive integer
    // enforces the contract the type merely asserts.
    const maxLenAttr = (f: { maxLength?: number }): string =>
      Number.isInteger(f.maxLength) && (f.maxLength as number) > 0
        ? `maxlength="${f.maxLength}"`
        : "";

    for (const f of fields) {
      let inputHtml: string;
      const val = st.orderFormData[f.id] ?? "";

      if (f.type === "textarea") {
        inputHtml = `<textarea data-order-field="${this.esc(seriesId)}:${this.esc(f.id)}" placeholder="${this.esc(f.placeholder || "")}" ${maxLenAttr(f)} rows="2">${this.esc(val)}</textarea>`;
      } else if (f.type === "select" && f.options) {
        const opts = f.options.map((o) =>
          `<option value="${this.esc(o)}" ${val === o ? "selected" : ""}>${this.esc(o)}</option>`
        ).join("");
        inputHtml = `<select data-order-field="${this.esc(seriesId)}:${this.esc(f.id)}"><option value="">Select...</option>${opts}</select>`;
      } else if (f.type === "checkbox") {
        inputHtml = `<label class="checkbox-row"><input type="checkbox" data-order-field="${this.esc(seriesId)}:${this.esc(f.id)}" ${val === "yes" ? "checked" : ""} /><span>${this.esc(f.placeholder || f.label)}</span></label>`;
      } else {
        inputHtml = `<input type="${this.esc(f.type)}" data-order-field="${this.esc(seriesId)}:${this.esc(f.id)}" value="${this.esc(val)}" placeholder="${this.esc(f.placeholder || "")}" ${maxLenAttr(f)} />`;
      }

      fieldsHtml += `
        <label class="form-field">
          <span class="form-label">${this.esc(f.label)}${f.required ? ' <span class="required">*</span>' : ""}</span>
          ${inputHtml}
        </label>
      `;
    }

    return fieldsHtml;
  }

  private renderBuyPanel(s: SeriesSummary, st: SeriesState): string {
    const avail = Number(st.status?.available ?? s.totalSupply);
    const maxQty = maxSelectableQty(avail);
    const qty = Math.min(st.quantity, maxQty);
    const fees = calculateBuyerFees(s.payment, qty);

    let qtyOptions = "";
    for (let i = 1; i <= maxQty; i++) {
      qtyOptions += `<option value="${i}" ${i === qty ? "selected" : ""}>${i}</option>`;
    }

    const totalHtml = fees?.cardTotal
      ? `<div class="total-row">
          <span>Total</span>
          <strong>${this.esc(fees.cardTotal)}</strong>
          ${fees.feePercent > 0 ? `<span class="fee-note">incl. ${this.esc(fees.fee)} booking fee</span>` : ""}
        </div>`
      : "";

    return `
      <div class="order-form" data-order-form="${this.esc(s.seriesId)}">
        ${this.hasOrderForm ? this.renderOrderFields(s.seriesId, st) : ""}
        <label class="form-field">
          <span class="form-label">Email for your ticket <span class="required">*</span></span>
          <input type="email" data-email-input="${this.esc(s.seriesId)}" value="${this.esc(st.email)}" placeholder="your@email.com" autocomplete="email" />
        </label>
        <label class="form-field qty-row">
          <span class="form-label">Quantity</span>
          <select data-qty-select="${this.esc(s.seriesId)}">${qtyOptions}</select>
        </label>
        ${totalHtml}
        ${this.renderConsent(s.seriesId, st)}
        <div class="claim-options">
          ${st.busy
            ? `<button class="claim-btn" disabled>Starting checkout...</button>`
            : `<button class="claim-btn" data-checkout="${this.esc(s.seriesId)}">Continue to payment</button>`}
        </div>
        ${st.error ? `<p class="error-msg">${this.esc(st.error)}</p>` : ""}
        <p class="redirect-note">You'll be redirected to Stripe's secure checkout. Your ticket arrives by email.</p>
        <div class="form-actions">
          ${this.hasOrderForm ? `<p class="encrypt-note">Your info is encrypted — only the organizer can read it.</p>` : "<span></span>"}
          <button class="cancel-btn" data-cancel-order="${this.esc(s.seriesId)}">Cancel</button>
        </div>
      </div>
    `;
  }

  private renderSeries(s: SeriesSummary, st?: SeriesState | null): string {
    // Coerced, not escaped: these render raw into markup AND drive `avail === 0`
    // below, so a string-typed API value would both inject and silently break the
    // sold-out branch. `Number()` on a non-numeric yields NaN, which renders as
    // "NaN" and compares false — visibly wrong, never executable.
    const avail = Number(st?.status?.available ?? s.totalSupply);
    const total = Number(st?.status?.totalSupply ?? s.totalSupply);
    const header = `
      <div class="series-info">
        <h3>${this.esc(s.name)}</h3>
        <p class="avail">${avail} / ${total} available</p>
      </div>
    `;

    if (st?.buyOpen && this.isPayable(s) && avail !== 0) {
      return `
        <div class="series-card series-card--expanded" data-series="${this.esc(s.seriesId)}">
          ${header}
          ${this.renderBuyPanel(s, st)}
        </div>
      `;
    }

    let actionHtml: string;
    if (!this.isPayable(s)) {
      // No live payment rail for this series (crypto-only, free, or a stale
      // cache entry from before prices were in the payload). Nothing can be
      // sold here — say so rather than dead-ending at checkout.
      actionHtml = `<button class="claim-btn" disabled>Not available here</button>`;
    } else if (avail === 0) {
      actionHtml = `<button class="claim-btn" disabled>Sold out</button>`;
    } else {
      const unit = calculateBuyerFees(s.payment, 1)?.unit ?? "";
      actionHtml = `<button class="claim-btn" data-buy="${this.esc(s.seriesId)}">Buy${unit ? ` — ${this.esc(unit)}` : ""}</button>`;
    }

    return `
      <div class="series-card" data-series="${this.esc(s.seriesId)}">
        ${header}
        ${actionHtml}
      </div>
    `;
  }

  /**
   * Validate required order fields and encrypt the buyer's answers (plus the
   * email, mirroring the main checkout's inline seal) to the organiser's
   * X25519 key. The fields never leave this page unencrypted — the server
   * stores the SealedBox and only the organiser's dashboard can open it.
   *
   * Returns undefined when there is nothing to seal or sealing failed (the
   * server builds a minimal fallback record at fulfilment — same trade the
   * main checkout makes: a lost form answer must not lose the sale), and
   * null when validation failed (stops the checkout).
   */
  private async encryptOrderData(seriesId: string, st: SeriesState, email: string): Promise<SealedBox | undefined | null> {
    const encryptionKey = this.event?.encryptionKey;
    if (!encryptionKey) return undefined;

    if (this.hasOrderForm) {
      for (const f of this.event?.orderFields ?? []) {
        if (f.required && !(st.orderFormData[f.id] ?? "").trim()) {
          st.error = `${f.label} is required`;
          this.updateSeries(seriesId);
          return null;
        }
      }
    }

    try {
      return await sealJson(encryptionKey, buildOrderPayload(st.orderFormData, seriesId, email));
    } catch {
      return undefined;
    }
  }

  /**
   * The v2 purchase path: optionally hold seats, create a guest Stripe
   * checkout session, and hand the buyer to Stripe. The ticket itself is
   * minted by the webhook at payment and delivered by email — nothing is
   * claimed in-page, so there is no signing ceremony and no account here.
   */
  private async handleCheckout(seriesId: string) {
    const st = this.seriesStates.get(seriesId);
    if (!st || st.busy || !this.api) return;

    const email = validateEmail(st.email);
    if (!email) {
      st.error = "Enter a valid email address";
      this.updateSeries(seriesId);
      return;
    }

    const encryptedOrder = await this.encryptOrderData(seriesId, st, email);
    if (encryptedOrder === null) return;

    st.busy = true;
    st.error = null;
    this.updateSeries(seriesId);

    try {
      // Hold the seats while the buyer is at Stripe — see reserveOutcome for
      // why every failure short of "Insufficient seats" proceeds without one.
      const rsv = await this.api.post<{ reservationId: string }>(
        `/api/events/${this.eventId}/series/${seriesId}/reserve`,
        { quantity: st.quantity },
      ).catch(() => null);
      const outcome = reserveOutcome(rsv);
      if (outcome.kind === "blocked") {
        st.error = outcome.message;
        st.busy = false;
        this.updateSeries(seriesId);
        return;
      }

      const body = buildCheckoutBody({
        eventId: this.eventId,
        seriesId,
        claimerEmail: email,
        quantity: st.quantity,
        marketingConsent: st.consent,
        cancelUrl: window.location.href,
        encryptedOrder,
        reservationId: outcome.kind === "reserved" ? outcome.reservationId : undefined,
      });

      const resp = await this.api.post<never>("/api/stripe/create-checkout", body);
      const url = (resp as Record<string, unknown>).url;
      if (!resp.ok || typeof url !== "string") {
        st.error = (resp.error as string) || "Failed to start checkout";
        st.busy = false;
        this.updateSeries(seriesId);
        return;
      }

      this.dispatchEvent(new CustomEvent("woco-checkout", {
        detail: { seriesId, quantity: st.quantity },
        bubbles: true,
      }));

      // Navigate the TOP window: Stripe Checkout refuses to render framed, so
      // inside the /embed/frame iframe the frame itself must not navigate.
      // Cross-origin top navigation is permitted under the click's transient
      // user activation; the fallback covers a sandboxed host page without
      // allow-top-navigation. href assignment (not replace) keeps the
      // organiser's page in history so Back from Stripe returns to it.
      try {
        (window.top ?? window).location.href = url;
      } catch {
        window.location.href = url;
      }
      // Deliberately leave st.busy = true — we are navigating away.
    } catch {
      st.error = "Network error";
      st.busy = false;
      this.updateSeries(seriesId);
    }
  }

  /**
   * Escape for interpolation into HTML — including into a double-quoted
   * ATTRIBUTE, which is how most call sites here use it (`data-series="..."`,
   * `data-buy="..."`). `textContent`→`innerHTML` alone escapes only
   * `& < >`, so a value containing a double quote could close the attribute and
   * open a new one; that is enough to inject an event handler without ever
   * needing a `<`. The strings interpolated are event/series fields fetched from
   * the API, so they are attacker-controlled by whoever authored the event —
   * not necessarily the organiser whose page hosts the widget. Escape the quotes
   * too, so attribute and text contexts are both safe.
   *
   * NOT a URL sanitiser and NOT a substitute for validation, and it does nothing
   * for values interpolated WITHOUT it. The other two contexts in this file are
   * therefore handled at their own call sites, not here: `appUrl` is scheme-
   * checked in its getter (escaping cannot stop `javascript:` — it contains no
   * character this touches), and numeric API fields are coerced, because the
   * contract to enforce there is "is a number", not "is inert text".
   */
  private esc(s: string): string {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
}
