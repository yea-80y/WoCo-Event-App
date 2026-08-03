import { createApiClient, type ApiClient } from "../api/client.js";
import { connectWallet, signClaimTypedData, isWalletAvailable } from "../auth/wallet.js";
import {
  isPasskeySupported,
  passkeySignIn,
  passkeyCreateAccount,
  PasskeyAssertionUnavailableError,
  signClaimDigest,
} from "../auth/passkey.js";
import { getStyles } from "./styles.js";
import {
  sealJson,
  CLAIM_DOMAIN,
  CLAIM_TYPES,
  eip712Digest,
  MARKETING_CONSENT_NOTICE,
  TRANSACTIONAL_EMAIL_NOTICE,
  CHECKOUT_PRIVACY_SUMMARY,
  type OrderField,
  type SealedBox,
} from "@woco/shared";
import { cacheGet, cacheSet, TTL_7D, embedCacheKey } from "../cache.js";

interface SeriesSummary {
  seriesId: string;
  name: string;
  description: string;
  totalSupply: number;
  approvalRequired?: boolean;
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
  claiming: boolean;
  claimedEdition: number | null;
  error: string | null;
  emailMode: boolean;
  orderFormVisible: boolean;
  orderFormData: Record<string, string>;
  passkeyConfirm: boolean; // show confirmation overlay before biometric
  /** Sign-in found no passkey — offer creating one as an EXPLICIT choice. */
  passkeyCreateOffer: boolean;
  pendingApproval: boolean; // claim submitted, awaiting organizer approval
}

export class WocoTickets extends HTMLElement {
  private api: ApiClient | null = null;
  private event: EventData | null = null;
  private seriesStates: Map<string, SeriesState> = new Map();
  private shadow: ShadowRoot;
  private delegationSetup = false;

  static get observedAttributes() {
    return ["event-id", "api-url", "claim-mode", "theme", "show-image", "show-description"];
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
    // attribute during initial parse (6x), all before connectedCallback. Without this
    // guard, 6 concurrent loadEvent() calls race and reset state mid-interaction.
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
   * instrument of an injection against a claimer mid-ceremony — at that moment
   * the claimer's derived account key is in this page's JS memory.
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
  private get claimMode() { return (this.getAttribute("claim-mode") || "email") as "wallet" | "email" | "both"; }
  private get theme() { return (this.getAttribute("theme") || "dark") as "dark" | "light"; }
  private get showImage() { return this.getAttribute("show-image") !== "false"; }
  private get showDescription() { return this.getAttribute("show-description") !== "false"; }

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
      // Restore cached series states (availability counts etc.)
      for (const s of cachedEvent.series) {
        const stKey = embedCacheKey.claimStatus(this.eventId, s.seriesId);
        const cachedStatus = cacheGet<ClaimStatus>(stKey);
        this.seriesStates.set(s.seriesId, {
          status: cachedStatus ?? null,
          claiming: false,
          claimedEdition: null,
          error: null,
          emailMode: false,
          orderFormVisible: false,
          orderFormData: {},
          passkeyConfirm: false,
          passkeyCreateOffer: false,
          pendingApproval: false,
        });
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

      // Merge fresh statuses — preserve any in-progress claim state
      for (let i = 0; i < freshEvent.series.length; i++) {
        const sid = freshEvent.series[i].seriesId;
        const existing = this.seriesStates.get(sid);
        this.seriesStates.set(sid, {
          status: statuses[i],
          // Preserve live UI state if user is mid-claim
          claiming: existing?.claiming ?? false,
          claimedEdition: existing?.claimedEdition ?? null,
          error: existing?.error ?? null,
          emailMode: existing?.emailMode ?? false,
          orderFormVisible: existing?.orderFormVisible ?? false,
          orderFormData: existing?.orderFormData ?? {},
          passkeyConfirm: existing?.passkeyConfirm ?? false,
          passkeyCreateOffer: existing?.passkeyCreateOffer ?? false,
          pendingApproval: existing?.pendingApproval ?? false,
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

  /** Returns true if the user has an active form open in any series card. */
  private isUserInteracting(): boolean {
    for (const [, st] of this.seriesStates) {
      if (st.claiming || st.orderFormVisible || st.passkeyConfirm || st.passkeyCreateOffer) return true;
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

      // data-wallet-claim
      const walletClaimBtn = target.closest<HTMLElement>("[data-wallet-claim]");
      if (walletClaimBtn) {
        const sid = walletClaimBtn.getAttribute("data-wallet-claim")!;
        const st = this.seriesStates.get(sid);
        if (this.hasOrderForm && st && !st.orderFormVisible) {
          st.orderFormVisible = true;
          this.updateSeries(sid);
        } else {
          this.handleWalletClaim(sid);
        }
        return;
      }

      // data-show-email
      const showEmailBtn = target.closest<HTMLElement>("[data-show-email]");
      if (showEmailBtn) {
        const sid = showEmailBtn.getAttribute("data-show-email")!;
        const st = this.seriesStates.get(sid);
        if (st) {
          st.emailMode = true;
          if (this.hasOrderForm && !st.orderFormVisible) st.orderFormVisible = true;
          this.updateSeries(sid);
        }
        return;
      }

      // data-email-claim
      const emailClaimBtn = target.closest<HTMLElement>("[data-email-claim]");
      if (emailClaimBtn) {
        const sid = emailClaimBtn.getAttribute("data-email-claim")!;
        this.handleEmailClaim(sid);
        return;
      }

      // data-cancel-order
      const cancelOrderBtn = target.closest<HTMLElement>("[data-cancel-order]");
      if (cancelOrderBtn) {
        const sid = cancelOrderBtn.getAttribute("data-cancel-order")!;
        const st = this.seriesStates.get(sid);
        if (st) {
          st.orderFormVisible = false;
          st.emailMode = false;
          st.orderFormData = {};
          st.error = null;
          this.updateSeries(sid);
        }
        return;
      }

      // data-passkey-claim — show confirm overlay first
      const passkeyClaimBtn = target.closest<HTMLElement>("[data-passkey-claim]");
      if (passkeyClaimBtn) {
        const sid = passkeyClaimBtn.getAttribute("data-passkey-claim")!;
        const st = this.seriesStates.get(sid);
        if (st) { st.passkeyConfirm = true; this.updateSeries(sid); }
        return;
      }

      // data-passkey-confirm — proceed with actual claim
      const passkeyConfirmBtn = target.closest<HTMLElement>("[data-passkey-confirm]");
      if (passkeyConfirmBtn) {
        const sid = passkeyConfirmBtn.getAttribute("data-passkey-confirm")!;
        const st = this.seriesStates.get(sid);
        if (st) st.passkeyConfirm = false;
        this.handlePasskeyClaim(sid);
        return;
      }

      // data-passkey-create — the ONLY path that mints a new passkey account.
      // Gate on the offer actually being open, not merely on the attribute being
      // present: the shadow root is `mode: "open"`, so the host page can inject an
      // element carrying this attribute and click it. That grants no capability a
      // hostile host page lacks (it can call `navigator.credentials.create()`
      // itself, and the native ceremony still runs), but minting an account is the
      // one action here that must follow from a decision the CLAIMER made — so
      // require the state that proves we asked them.
      const passkeyCreateBtn = target.closest<HTMLElement>("[data-passkey-create]");
      if (passkeyCreateBtn) {
        const sid = passkeyCreateBtn.getAttribute("data-passkey-create")!;
        if (this.seriesStates.get(sid)?.passkeyCreateOffer) {
          this.handlePasskeyClaim(sid, true);
        }
        return;
      }

      // data-cancel-passkey
      const cancelPasskeyBtn = target.closest<HTMLElement>("[data-cancel-passkey]");
      if (cancelPasskeyBtn) {
        const sid = cancelPasskeyBtn.getAttribute("data-cancel-passkey")!;
        const st = this.seriesStates.get(sid);
        if (st) { st.passkeyConfirm = false; st.passkeyCreateOffer = false; this.updateSeries(sid); }
        return;
      }

      // data-wallet-order / data-both-order — show order form
      const orderBtn = target.closest<HTMLElement>("[data-wallet-order], [data-both-order]");
      if (orderBtn) {
        const sid = orderBtn.getAttribute("data-wallet-order") || orderBtn.getAttribute("data-both-order")!;
        const st = this.seriesStates.get(sid);
        if (st) { st.orderFormVisible = true; this.updateSeries(sid); }
        return;
      }
    });

    // Order form field sync — update state without re-rendering
    this.shadow.addEventListener("input", (e) => {
      const el = e.target as HTMLElement;
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

  private readonly fingerprintIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12C2 6.5 6.5 2 12 2a10 10 0 0 1 8 4"/><path d="M5 19.5C5.5 18 6 15 6 12c0-.7.12-1.37.34-2"/><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/><path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M8.65 22c.21-.66.45-1.32.57-2"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M2 16h.01"/><path d="M21.8 16c.2-2 .131-5.354 0-6"/><path d="M9 6.8a6 6 0 0 1 9 5.2c0 .47 0 1.17-.02 2"/></svg>`;

  /**
   * Point-of-collection notice + marketing opt-in.
   *
   * The widget runs on the ORGANISER'S domain, where the buyer has never seen a
   * WoCo page — so the disclosure and the PECR opt-out have to travel with the
   * form. Wording is kept byte-identical to the main checkout (shared/legal
   * consent.ts) because the server stores it as Art. 7(1) evidence — the two
   * surfaces must not drift, so both read the same shared constants.
   */
  private renderConsent(seriesId: string): string {
    return `
      <div class="consent-block">
        <div class="transactional-note">${this.esc(TRANSACTIONAL_EMAIL_NOTICE)}</div>
        <label class="consent-row">
          <input type="checkbox" data-marketing-consent="${this.esc(seriesId)}" />
          <span>${this.esc(MARKETING_CONSENT_NOTICE)}</span>
        </label>
        <div class="privacy-note">
          ${this.esc(CHECKOUT_PRIVACY_SUMMARY)}
          <a href="${this.esc(this.appUrl)}/#/legal/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>
        </div>
      </div>
    `;
  }

  private renderPasskeyButton(seriesId: string, disabled = false, approvalRequired = false): string {
    return `
      <div class="passkey-section">
        <button class="passkey-btn" data-passkey-claim="${this.esc(seriesId)}" ${disabled ? "disabled" : ""}>
          ${this.fingerprintIcon}
          ${approvalRequired ? "Request with passkey" : "Claim with passkey"}
        </button>
        <div class="passkey-providers">Secured by Apple, Google, 1Password</div>
      </div>
    `;
  }

  private renderPasskeyConfirm(seriesId: string, ticketName: string, approvalRequired = false): string {
    return `
      <div class="passkey-confirm">
        <p class="passkey-confirm-title">${approvalRequired ? "Confirm request" : "Confirm claim"}</p>
        <p class="passkey-confirm-detail">
          <span class="passkey-confirm-label">Ticket</span>
          <span>${this.esc(ticketName)}</span>
        </p>
        <p class="passkey-confirm-detail">
          <span class="passkey-confirm-label">Sign with</span>
          <span>Your passkey (${this.esc(window.location.hostname)})</span>
        </p>
        <p class="passkey-confirm-note">Your passkey will authenticate this ${approvalRequired ? "request" : "claim"}. No personal data is shared.</p>
        <div class="passkey-confirm-actions">
          <button class="cancel-btn" data-cancel-passkey="${this.esc(seriesId)}">Cancel</button>
          <button class="passkey-btn passkey-btn--confirm" data-passkey-confirm="${this.esc(seriesId)}">
            ${this.fingerprintIcon}
            ${approvalRequired ? "Sign &amp; Request" : "Sign &amp; Claim"}
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Shown when sign-in produced no assertion. Deliberately offers BOTH paths and
   * names the consequence: a new passkey is a new account, not a way back into an
   * existing one. Retry is listed first because "I cancelled" and "I have none
   * here" are indistinguishable to us, and retry is the non-destructive answer.
   */
  private renderPasskeyCreateOffer(seriesId: string): string {
    return `
      <div class="passkey-confirm">
        <p class="passkey-confirm-title">No passkey used</p>
        <p class="passkey-confirm-note">
          Either you cancelled, or this device has no WoCo passkey yet. If you already
          have a WoCo account, try again and pick your passkey — creating a new one
          makes a separate account and will not restore your existing tickets.
        </p>
        <div class="passkey-confirm-actions">
          <button class="passkey-btn passkey-btn--confirm" data-passkey-confirm="${this.esc(seriesId)}">
            ${this.fingerprintIcon}
            Try again
          </button>
        </div>
        <div class="passkey-confirm-actions">
          <button class="cancel-btn" data-passkey-create="${this.esc(seriesId)}">
            Create a new passkey account
          </button>
        </div>
      </div>
    `;
  }

  private get hasOrderForm(): boolean {
    return !!(this.event?.orderFields?.length && this.event?.encryptionKey);
  }

  private renderOrderForm(seriesId: string, st: SeriesState, approvalRequired = false): string {
    const fields = this.event?.orderFields ?? [];
    let fieldsHtml = "";

    // `maxlength` is interpolated RAW into a double-quoted attribute below, so
    // escaping is not enough — coerce, because the value is not trustworthy.
    // `OrderField.maxLength` is typed `number?` but that is a COMPILE-TIME claim
    // about our own code; the value arrives as JSON from the event manifest and
    // the server never validates orderFields (it destructures and passes the
    // array straight through — apps/server/src/routes/events.ts:185,341, whose
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

    const mode = this.claimMode;
    const passkeyAvail = isPasskeySupported();
    let submitHtml: string;
    const claimLabel = approvalRequired ? "Request" : "Claim";
    if (st.claiming) {
      submitHtml = `<button class="claim-btn" disabled>${approvalRequired ? "Requesting..." : "Claiming..."}</button>`;
    } else if (mode === "email" || st.emailMode) {
      submitHtml = `
        <div class="email-form">
          <input type="email" placeholder="your@email.com" data-email-input="${this.esc(seriesId)}" />
          <button class="claim-btn" data-email-claim="${this.esc(seriesId)}">${claimLabel}</button>
        </div>
        ${this.renderConsent(seriesId)}
      `;
    } else if (mode === "wallet") {
      // Wallet: sign claim message via MetaMask (EIP-191) + passkey
      const walletAvail = isWalletAvailable();
      submitHtml = walletAvail
        ? `<button class="claim-btn" data-wallet-claim="${this.esc(seriesId)}">${claimLabel} with wallet</button>`
        : `<button class="claim-btn" disabled>No wallet detected</button>`;
      if (passkeyAvail) {
        submitHtml += `<div class="passkey-divider">or</div>` + this.renderPasskeyButton(seriesId, false, approvalRequired);
      }
    } else {
      // both — email + wallet + passkey
      submitHtml = `
        <div class="email-form">
          <input type="email" placeholder="your@email.com" data-email-input="${this.esc(seriesId)}" />
          <button class="claim-btn" data-email-claim="${this.esc(seriesId)}">${claimLabel}</button>
        </div>
        ${this.renderConsent(seriesId)}
      `;
      if (isWalletAvailable()) {
        submitHtml += `<div class="passkey-divider">or</div>
          <button class="claim-btn" data-wallet-claim="${this.esc(seriesId)}">${claimLabel} with wallet</button>`;
      }
      if (passkeyAvail) {
        submitHtml += `<div class="passkey-divider">or</div>` + this.renderPasskeyButton(seriesId, false, approvalRequired);
      }
    }

    return `
      <div class="order-form" data-order-form="${this.esc(seriesId)}">
        ${fieldsHtml}
        <div class="claim-options">
          ${submitHtml}
        </div>
        ${st.error ? `<p class="error-msg">${this.esc(st.error)}</p>` : ""}
        <div class="form-actions">
          <p class="encrypt-note">Your info is encrypted — only the organizer can read it.</p>
          <button class="cancel-btn" data-cancel-order="${this.esc(seriesId)}">Cancel</button>
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

    if (st?.pendingApproval) {
      return `
        <div class="series-card series-card--expanded" data-series="${this.esc(s.seriesId)}">
          <div class="series-info">
            <h3>${this.esc(s.name)}</h3>
            <p class="avail">${avail} / ${total} available</p>
          </div>
          <div class="pending-approval-badge">&#9679; Pending Approval</div>
          <p class="pending-approval-msg">Your request has been submitted. You'll receive your ticket once the organiser approves it.</p>
        </div>
      `;
    }

    if (st?.claimedEdition != null) {
      return `
        <div class="series-card" data-series="${this.esc(s.seriesId)}">
          <div class="series-info">
            <h3>${this.esc(s.name)}</h3>
            <p class="avail">${avail} / ${total} available</p>
          </div>
          <div class="claimed-badge">&#10003; Claimed #${Number(st.claimedEdition)}</div>
        </div>
      `;
    }

    const approvalRequired = s.approvalRequired ?? false;
    const claimLabel = approvalRequired ? "Request to attend" : "Claim ticket";

    // Passkey confirmation overlay
    if (st?.passkeyConfirm) {
      return `
        <div class="series-card series-card--expanded" data-series="${this.esc(s.seriesId)}">
          <div class="series-info">
            <h3>${this.esc(s.name)}</h3>
            <p class="avail">${avail} / ${total} available</p>
          </div>
          ${this.renderPasskeyConfirm(s.seriesId, s.name, approvalRequired)}
        </div>
      `;
    }

    // Sign-in found no passkey — creating one is the user's call, never ours
    if (st?.passkeyCreateOffer) {
      return `
        <div class="series-card series-card--expanded" data-series="${this.esc(s.seriesId)}">
          <div class="series-info">
            <h3>${this.esc(s.name)}</h3>
            <p class="avail">${avail} / ${total} available</p>
          </div>
          ${this.renderPasskeyCreateOffer(s.seriesId)}
        </div>
      `;
    }

    // Show order form if visible
    if (st?.orderFormVisible && this.hasOrderForm) {
      return `
        <div class="series-card series-card--expanded" data-series="${this.esc(s.seriesId)}">
          <div class="series-info">
            <h3>${this.esc(s.name)}</h3>
            <p class="avail">${avail} / ${total} available</p>
          </div>
          ${this.renderOrderForm(s.seriesId, st, approvalRequired)}
        </div>
      `;
    }

    let actionHtml: string;
    if (st?.claiming) {
      actionHtml = `<button class="claim-btn" disabled>${approvalRequired ? "Requesting..." : "Claiming..."}</button>`;
    } else if (avail === 0) {
      actionHtml = `<button class="claim-btn" disabled>Sold out</button>`;
    } else if (st?.emailMode && !this.hasOrderForm) {
      actionHtml = `
        <div>
          <div class="email-form">
            <input type="email" placeholder="your@email.com" data-email-input="${this.esc(s.seriesId)}" />
            <button class="claim-btn" data-email-claim="${this.esc(s.seriesId)}">${approvalRequired ? "Request" : "Claim"}</button>
          </div>
          ${st?.error ? `<p class="error-msg">${this.esc(st.error)}</p>` : ""}
        </div>
      `;
    } else {
      const mode = this.claimMode;
      const passkeyAvail = isPasskeySupported();
      if (mode === "email") {
        actionHtml = `<button class="claim-btn" data-show-email="${this.esc(s.seriesId)}">${approvalRequired ? "Request to attend" : "Claim with email"}</button>`;
      } else if (mode === "wallet") {
        // Wallet: sign claim message via MetaMask (EIP-191) + passkey
        if (this.hasOrderForm) {
          actionHtml = `<button class="claim-btn" data-wallet-order="${this.esc(s.seriesId)}">${claimLabel}</button>`;
        } else {
          const walletAvail = isWalletAvailable();
          actionHtml = `<div class="claim-options">
            ${walletAvail
              ? `<button class="claim-btn" data-wallet-claim="${this.esc(s.seriesId)}">${approvalRequired ? "Request with wallet" : "Claim with wallet"}</button>`
              : `<button class="claim-btn" disabled>No wallet detected</button>`}
            ${passkeyAvail ? `<div class="passkey-divider">or</div>` + this.renderPasskeyButton(s.seriesId, false, approvalRequired) : ""}
          </div>`;
        }
      } else {
        // both — email + wallet + passkey
        if (this.hasOrderForm) {
          actionHtml = `<button class="claim-btn" data-both-order="${this.esc(s.seriesId)}">${claimLabel}</button>`;
        } else {
          const walletAvail = isWalletAvailable();
          actionHtml = `
            <div class="claim-options">
              <button class="claim-btn" data-show-email="${this.esc(s.seriesId)}">${approvalRequired ? "Request with email" : "Claim with email"}</button>
              ${walletAvail ? `<div class="passkey-divider">or</div>
                <button class="claim-btn" data-wallet-claim="${this.esc(s.seriesId)}">${approvalRequired ? "Request with wallet" : "Claim with wallet"}</button>` : ""}
              ${passkeyAvail ? `<div class="passkey-divider">or</div>` + this.renderPasskeyButton(s.seriesId, false, approvalRequired) : ""}
            </div>
          `;
        }
      }
      if (st?.error) {
        actionHtml += `<p class="error-msg">${this.esc(st.error)}</p>`;
      }
    }

    const hasMultipleOptions = actionHtml.includes("claim-options");
    return `
      <div class="series-card${hasMultipleOptions ? " series-card--expanded" : ""}" data-series="${this.esc(s.seriesId)}">
        <div class="series-info">
          <h3>${this.esc(s.name)}</h3>
          <p class="avail">${avail} / ${total} available</p>
        </div>
        ${actionHtml}
      </div>
    `;
  }

  /**
   * Validate required order fields and encrypt form data if present.
   * Returns undefined if no order form, or the encrypted SealedBox.
   * Sets st.error and returns null if validation fails.
   */
  private async encryptOrderData(seriesId: string, st: SeriesState): Promise<SealedBox | undefined | null> {
    if (!this.hasOrderForm || !st.orderFormVisible) return undefined;

    const fields = this.event?.orderFields ?? [];
    const encryptionKey = this.event?.encryptionKey;

    // Validate required fields
    for (const f of fields) {
      if (f.required && !(st.orderFormData[f.id] ?? "").trim()) {
        st.error = `${f.label} is required`;
        this.updateSeries(seriesId);
        return null;
      }
    }

    try {
      return await sealJson(encryptionKey!, {
        fields: st.orderFormData,
        seriesId,
      });
    } catch {
      st.error = "Failed to encrypt your info";
      this.updateSeries(seriesId);
      return null;
    }
  }

  private async handleWalletClaim(seriesId: string) {
    const st = this.seriesStates.get(seriesId);
    if (!st || st.claiming || !this.api) return;

    st.claiming = true;
    st.error = null;
    this.updateSeries(seriesId);

    // Encrypt order data if form is present
    const encryptedOrder = await this.encryptOrderData(seriesId, st);
    if (encryptedOrder === null) { st.claiming = false; return; }

    const address = await connectWallet();
    if (!address) {
      st.claiming = false;
      st.error = "Wallet not available or connection rejected";
      this.updateSeries(seriesId);
      return;
    }

    // Sign EIP-712 typed data — wallet displays structured claim fields.
    // No session delegation needed for embed path.
    const timestamp = Date.now();
    const typedData = {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "salt", type: "bytes32" },
        ],
        ClaimTicket: CLAIM_TYPES.ClaimTicket,
      },
      domain: CLAIM_DOMAIN,
      primaryType: "ClaimTicket",
      message: {
        eventId: this.eventId,
        seriesId,
        claimer: address.toLowerCase(),
        timestamp,
      },
    };
    const signature = await signClaimTypedData(address, typedData);
    if (!signature) {
      st.claiming = false;
      st.error = "Wallet signing rejected";
      this.updateSeries(seriesId);
      return;
    }

    try {
      const body: Record<string, unknown> = { mode: "wallet-signed", address, signature, timestamp };
      if (encryptedOrder) body.encryptedOrder = encryptedOrder;

      const resp = await this.api.post<unknown>(
        `/api/events/${this.eventId}/series/${seriesId}/claim`,
        body,
      );

      if (!resp.ok) {
        st.error = (resp.error as string) || "Claim failed";
      } else if ((resp as Record<string, unknown>).approvalPending) {
        st.pendingApproval = true;
        st.orderFormVisible = false;
      } else {
        st.claimedEdition = (resp as Record<string, unknown>).edition as number ?? null;
        st.orderFormVisible = false;
        this.dispatchEvent(new CustomEvent("woco-claim", {
          detail: { seriesId, mode: "wallet", address, edition: st.claimedEdition },
          bubbles: true,
        }));
      }
    } catch {
      st.error = "Network error";
    } finally {
      st.claiming = false;
      this.updateSeries(seriesId);
    }
  }

  private async handlePasskeyClaim(seriesId: string, createAccount = false) {
    const st = this.seriesStates.get(seriesId);
    if (!st || st.claiming || !this.api) return;

    st.claiming = true;
    st.error = null;
    st.passkeyCreateOffer = false;
    this.updateSeries(seriesId);

    // Encrypt order data if form is present
    const encryptedOrder = await this.encryptOrderData(seriesId, st);
    if (encryptedOrder === null) { st.claiming = false; return; }

    let privateKey: Uint8Array;
    let address: string;
    try {
      const result = createAccount ? await passkeyCreateAccount() : await passkeySignIn();
      privateKey = result.privateKey;
      address = result.address;
    } catch (err) {
      st.claiming = false;
      // Sign-in found no assertion. That means "you cancelled" OR "there is no
      // WoCo passkey here" — indistinguishable by spec, so ask rather than mint
      // an account the claimer did not ask for.
      if (err instanceof PasskeyAssertionUnavailableError) {
        st.passkeyCreateOffer = true;
        st.error = null;
      } else {
        st.error = err instanceof Error ? err.message : "Passkey authentication failed";
      }
      this.updateSeries(seriesId);
      return;
    }

    // Build EIP-712 claim digest and sign with the passkey-derived secp256k1 key
    const timestamp = Date.now();
    const claimMessage = {
      eventId: this.eventId,
      seriesId,
      claimer: address.toLowerCase(),
      timestamp,
    };
    const digest = eip712Digest(
      CLAIM_DOMAIN,
      "ClaimTicket",
      CLAIM_TYPES.ClaimTicket,
      claimMessage,
    );
    const signature = signClaimDigest(privateKey, digest);

    try {
      const body: Record<string, unknown> = { mode: "passkey", address, signature, timestamp };
      if (encryptedOrder) body.encryptedOrder = encryptedOrder;

      const resp = await this.api.post<unknown>(
        `/api/events/${this.eventId}/series/${seriesId}/claim`,
        body,
      );

      if (!resp.ok) {
        st.error = (resp.error as string) || "Claim failed";
      } else if ((resp as Record<string, unknown>).approvalPending) {
        st.pendingApproval = true;
        st.orderFormVisible = false;
      } else {
        st.claimedEdition = (resp as Record<string, unknown>).edition as number ?? null;
        st.orderFormVisible = false;
        this.dispatchEvent(new CustomEvent("woco-claim", {
          detail: { seriesId, mode: "passkey", address, edition: st.claimedEdition },
          bubbles: true,
        }));
      }
    } catch {
      st.error = "Network error";
    } finally {
      st.claiming = false;
      this.updateSeries(seriesId);
    }
  }

  private async handleEmailClaim(seriesId: string) {
    const st = this.seriesStates.get(seriesId);
    if (!st || st.claiming || !this.api) return;

    const input = this.shadow.querySelector<HTMLInputElement>(
      `[data-email-input="${CSS.escape(seriesId)}"]`,
    );
    const email = input?.value?.trim();
    if (!email || !email.includes("@")) {
      st.error = "Enter a valid email address";
      this.updateSeries(seriesId);
      return;
    }

    st.claiming = true;
    st.error = null;
    this.updateSeries(seriesId);

    // Encrypt order data if form is present
    const encryptedOrder = await this.encryptOrderData(seriesId, st);
    if (encryptedOrder === null) { st.claiming = false; return; }

    try {
      const body: Record<string, unknown> = { mode: "email", email };
      if (encryptedOrder) body.encryptedOrder = encryptedOrder;
      // The form was rendered, so the opt-out WAS offered — an untouched box is
      // an explicit refusal (recorded as a suppression), not "never asked".
      body.marketingConsent = !!this.shadow.querySelector<HTMLInputElement>(
        `[data-marketing-consent="${CSS.escape(seriesId)}"]`,
      )?.checked;

      const resp = await this.api.post<unknown>(
        `/api/events/${this.eventId}/series/${seriesId}/claim`,
        body,
      );

      if (!resp.ok) {
        st.error = (resp.error as string) || "Claim failed";
      } else if ((resp as Record<string, unknown>).approvalPending) {
        st.pendingApproval = true;
        st.orderFormVisible = false;
      } else {
        st.claimedEdition = (resp as Record<string, unknown>).edition as number ?? null;
        st.orderFormVisible = false;
        this.dispatchEvent(new CustomEvent("woco-claim", {
          detail: { seriesId, mode: "email", email, edition: st.claimedEdition },
          bubbles: true,
        }));
      }
    } catch {
      st.error = "Network error";
    } finally {
      st.claiming = false;
      this.updateSeries(seriesId);
    }
  }

  /**
   * Escape for interpolation into HTML — including into a double-quoted
   * ATTRIBUTE, which is how most call sites here use it (`data-series="..."`,
   * `data-passkey-create="..."`). `textContent`→`innerHTML` alone escapes only
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
