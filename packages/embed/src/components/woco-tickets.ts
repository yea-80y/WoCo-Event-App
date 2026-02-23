import { createApiClient, type ApiClient } from "../api/client.js";
import { connectWallet, signClaimMessage as signWithWallet, isWalletAvailable } from "../auth/wallet.js";
import { isPasskeySupported, passkeyAuthenticate, signClaimMessage } from "../auth/passkey.js";
import { getStyles } from "./styles.js";
import { sealJson, PASSKEY_CLAIM_PREFIX, type OrderField, type SealedBox } from "@woco/shared";

interface SeriesSummary {
  seriesId: string;
  name: string;
  description: string;
  totalSupply: number;
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
  private get claimMode() { return (this.getAttribute("claim-mode") || "email") as "wallet" | "email" | "both"; }
  private get theme() { return (this.getAttribute("theme") || "dark") as "dark" | "light"; }
  private get showImage() { return this.getAttribute("show-image") !== "false"; }
  private get showDescription() { return this.getAttribute("show-description") !== "false"; }

  private async loadEvent() {
    if (!this.eventId || !this.apiUrl) return;

    this.api = createApiClient(this.apiUrl);
    this.renderLoading();

    try {
      const resp = await this.api.get<EventData>(`/api/events/${this.eventId}`);
      if (!resp.ok || !resp.data) {
        this.renderError("Event not found");
        return;
      }
      this.event = resp.data;

      // Fetch claim statuses in parallel
      const statuses = await Promise.all(
        this.event.series.map(async (s) => {
          try {
            const r = await this.api!.get<ClaimStatus>(
              `/api/events/${this.eventId}/series/${s.seriesId}/claim-status`,
            );
            return r.data ?? null;
          } catch {
            return null;
          }
        }),
      );

      for (let i = 0; i < this.event.series.length; i++) {
        this.seriesStates.set(this.event.series[i].seriesId, {
          status: statuses[i],
          claiming: false,
          claimedEdition: null,
          error: null,
          emailMode: false,
          orderFormVisible: false,
          orderFormData: {},
          passkeyConfirm: false,
        });
      }

      this.render();
    } catch {
      this.renderError("Failed to load event");
    }
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

      // data-cancel-passkey
      const cancelPasskeyBtn = target.closest<HTMLElement>("[data-cancel-passkey]");
      if (cancelPasskeyBtn) {
        const sid = cancelPasskeyBtn.getAttribute("data-cancel-passkey")!;
        const st = this.seriesStates.get(sid);
        if (st) { st.passkeyConfirm = false; this.updateSeries(sid); }
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

  private renderPasskeyButton(seriesId: string, disabled = false): string {
    return `
      <div class="passkey-section">
        <button class="passkey-btn" data-passkey-claim="${this.esc(seriesId)}" ${disabled ? "disabled" : ""}>
          ${this.fingerprintIcon}
          Claim with passkey
        </button>
        <div class="passkey-providers">Secured by Apple, Google, 1Password</div>
      </div>
    `;
  }

  private renderPasskeyConfirm(seriesId: string, ticketName: string): string {
    return `
      <div class="passkey-confirm">
        <p class="passkey-confirm-title">Confirm claim</p>
        <p class="passkey-confirm-detail">
          <span class="passkey-confirm-label">Ticket</span>
          <span>${this.esc(ticketName)}</span>
        </p>
        <p class="passkey-confirm-detail">
          <span class="passkey-confirm-label">Sign with</span>
          <span>Your passkey (${this.esc(window.location.hostname)})</span>
        </p>
        <p class="passkey-confirm-note">Your passkey will authenticate this claim. No personal data is shared.</p>
        <div class="passkey-confirm-actions">
          <button class="cancel-btn" data-cancel-passkey="${this.esc(seriesId)}">Cancel</button>
          <button class="passkey-btn passkey-btn--confirm" data-passkey-confirm="${this.esc(seriesId)}">
            ${this.fingerprintIcon}
            Sign &amp; Claim
          </button>
        </div>
      </div>
    `;
  }

  private get hasOrderForm(): boolean {
    return !!(this.event?.orderFields?.length && this.event?.encryptionKey);
  }

  private renderOrderForm(seriesId: string, st: SeriesState): string {
    const fields = this.event?.orderFields ?? [];
    let fieldsHtml = "";

    for (const f of fields) {
      let inputHtml: string;
      const val = st.orderFormData[f.id] ?? "";

      if (f.type === "textarea") {
        inputHtml = `<textarea data-order-field="${this.esc(seriesId)}:${this.esc(f.id)}" placeholder="${this.esc(f.placeholder || "")}" ${f.maxLength ? `maxlength="${f.maxLength}"` : ""} rows="2">${this.esc(val)}</textarea>`;
      } else if (f.type === "select" && f.options) {
        const opts = f.options.map((o) =>
          `<option value="${this.esc(o)}" ${val === o ? "selected" : ""}>${this.esc(o)}</option>`
        ).join("");
        inputHtml = `<select data-order-field="${this.esc(seriesId)}:${this.esc(f.id)}"><option value="">Select...</option>${opts}</select>`;
      } else if (f.type === "checkbox") {
        inputHtml = `<label class="checkbox-row"><input type="checkbox" data-order-field="${this.esc(seriesId)}:${this.esc(f.id)}" ${val === "yes" ? "checked" : ""} /><span>${this.esc(f.placeholder || f.label)}</span></label>`;
      } else {
        inputHtml = `<input type="${this.esc(f.type)}" data-order-field="${this.esc(seriesId)}:${this.esc(f.id)}" value="${this.esc(val)}" placeholder="${this.esc(f.placeholder || "")}" ${f.maxLength ? `maxlength="${f.maxLength}"` : ""} />`;
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
    if (st.claiming) {
      submitHtml = `<button class="claim-btn" disabled>Claiming...</button>`;
    } else if (mode === "email" || st.emailMode) {
      submitHtml = `
        <div class="email-form">
          <input type="email" placeholder="your@email.com" data-email-input="${this.esc(seriesId)}" />
          <button class="claim-btn" data-email-claim="${this.esc(seriesId)}">Claim</button>
        </div>
      `;
    } else if (mode === "wallet") {
      // Wallet: sign claim message via MetaMask (EIP-191) + passkey
      const walletAvail = isWalletAvailable();
      submitHtml = walletAvail
        ? `<button class="claim-btn" data-wallet-claim="${this.esc(seriesId)}">Claim with wallet</button>`
        : `<button class="claim-btn" disabled>No wallet detected</button>`;
      if (passkeyAvail) {
        submitHtml += `<div class="passkey-divider">or</div>` + this.renderPasskeyButton(seriesId);
      }
    } else {
      // both — email + wallet + passkey
      submitHtml = `
        <div class="email-form">
          <input type="email" placeholder="your@email.com" data-email-input="${this.esc(seriesId)}" />
          <button class="claim-btn" data-email-claim="${this.esc(seriesId)}">Claim</button>
        </div>
      `;
      if (isWalletAvailable()) {
        submitHtml += `<div class="passkey-divider">or</div>
          <button class="claim-btn" data-wallet-claim="${this.esc(seriesId)}">Claim with wallet</button>`;
      }
      if (passkeyAvail) {
        submitHtml += `<div class="passkey-divider">or</div>` + this.renderPasskeyButton(seriesId);
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
    const avail = st?.status?.available ?? s.totalSupply;
    const total = st?.status?.totalSupply ?? s.totalSupply;

    if (st?.claimedEdition != null) {
      return `
        <div class="series-card" data-series="${this.esc(s.seriesId)}">
          <div class="series-info">
            <h3>${this.esc(s.name)}</h3>
            <p class="avail">${avail} / ${total} available</p>
          </div>
          <div class="claimed-badge">&#10003; Claimed #${st.claimedEdition}</div>
        </div>
      `;
    }

    // Passkey confirmation overlay
    if (st?.passkeyConfirm) {
      return `
        <div class="series-card series-card--expanded" data-series="${this.esc(s.seriesId)}">
          <div class="series-info">
            <h3>${this.esc(s.name)}</h3>
            <p class="avail">${avail} / ${total} available</p>
          </div>
          ${this.renderPasskeyConfirm(s.seriesId, s.name)}
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
          ${this.renderOrderForm(s.seriesId, st)}
        </div>
      `;
    }

    let actionHtml: string;
    if (st?.claiming) {
      actionHtml = `<button class="claim-btn" disabled>Claiming...</button>`;
    } else if (avail === 0) {
      actionHtml = `<button class="claim-btn" disabled>Sold out</button>`;
    } else if (st?.emailMode && !this.hasOrderForm) {
      actionHtml = `
        <div>
          <div class="email-form">
            <input type="email" placeholder="your@email.com" data-email-input="${this.esc(s.seriesId)}" />
            <button class="claim-btn" data-email-claim="${this.esc(s.seriesId)}">Claim</button>
          </div>
          ${st?.error ? `<p class="error-msg">${this.esc(st.error)}</p>` : ""}
        </div>
      `;
    } else {
      const mode = this.claimMode;
      const passkeyAvail = isPasskeySupported();
      if (mode === "email") {
        actionHtml = `<button class="claim-btn" data-show-email="${this.esc(s.seriesId)}">Claim with email</button>`;
      } else if (mode === "wallet") {
        // Wallet: sign claim message via MetaMask (EIP-191) + passkey
        if (this.hasOrderForm) {
          actionHtml = `<button class="claim-btn" data-wallet-order="${this.esc(s.seriesId)}">Claim ticket</button>`;
        } else {
          const walletAvail = isWalletAvailable();
          actionHtml = `<div class="claim-options">
            ${walletAvail
              ? `<button class="claim-btn" data-wallet-claim="${this.esc(s.seriesId)}">Claim with wallet</button>`
              : `<button class="claim-btn" disabled>No wallet detected</button>`}
            ${passkeyAvail ? `<div class="passkey-divider">or</div>` + this.renderPasskeyButton(s.seriesId) : ""}
          </div>`;
        }
      } else {
        // both — email + wallet + passkey
        if (this.hasOrderForm) {
          actionHtml = `<button class="claim-btn" data-both-order="${this.esc(s.seriesId)}">Claim ticket</button>`;
        } else {
          const walletAvail = isWalletAvailable();
          actionHtml = `
            <div class="claim-options">
              <button class="claim-btn" data-show-email="${this.esc(s.seriesId)}">Claim with email</button>
              ${walletAvail ? `<div class="passkey-divider">or</div>
                <button class="claim-btn" data-wallet-claim="${this.esc(s.seriesId)}">Claim with wallet</button>` : ""}
              ${passkeyAvail ? `<div class="passkey-divider">or</div>` + this.renderPasskeyButton(s.seriesId) : ""}
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

    // Sign claim message — same EIP-191 approach as passkey, no session delegation needed
    const timestamp = Date.now();
    const message = PASSKEY_CLAIM_PREFIX + this.eventId + ":" + seriesId + ":" + timestamp;
    const signature = await signWithWallet(address, message);
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

  private async handlePasskeyClaim(seriesId: string) {
    const st = this.seriesStates.get(seriesId);
    if (!st || st.claiming || !this.api) return;

    st.claiming = true;
    st.error = null;
    this.updateSeries(seriesId);

    // Encrypt order data if form is present
    const encryptedOrder = await this.encryptOrderData(seriesId, st);
    if (encryptedOrder === null) { st.claiming = false; return; }

    let privateKey: Uint8Array;
    let address: string;
    try {
      const result = await passkeyAuthenticate();
      privateKey = result.privateKey;
      address = result.address;
    } catch (err) {
      st.claiming = false;
      st.error = err instanceof Error ? err.message : "Passkey authentication failed";
      this.updateSeries(seriesId);
      return;
    }

    // Build and sign claim message
    const timestamp = Date.now();
    const message = PASSKEY_CLAIM_PREFIX + this.eventId + ":" + seriesId + ":" + timestamp;
    const signature = signClaimMessage(privateKey, message);

    try {
      const body: Record<string, unknown> = { mode: "passkey", address, signature, timestamp };
      if (encryptedOrder) body.encryptedOrder = encryptedOrder;

      const resp = await this.api.post<unknown>(
        `/api/events/${this.eventId}/series/${seriesId}/claim`,
        body,
      );

      if (!resp.ok) {
        st.error = (resp.error as string) || "Claim failed";
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
      `[data-email-input="${seriesId}"]`,
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

      const resp = await this.api.post<unknown>(
        `/api/events/${this.eventId}/series/${seriesId}/claim`,
        body,
      );

      if (!resp.ok) {
        st.error = (resp.error as string) || "Claim failed";
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

  private esc(s: string): string {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }
}
