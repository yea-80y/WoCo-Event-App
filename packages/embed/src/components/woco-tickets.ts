import { createApiClient, type ApiClient } from "../api/client.js";
import { connectWallet } from "../auth/wallet.js";
import { getStyles } from "./styles.js";
import { sealJson, type OrderField, type SealedBox } from "@woco/shared";

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
}

export class WocoTickets extends HTMLElement {
  private api: ApiClient | null = null;
  private event: EventData | null = null;
  private seriesStates: Map<string, SeriesState> = new Map();
  private shadow: ShadowRoot;

  static get observedAttributes() {
    return ["event-id", "api-url", "claim-mode", "theme", "show-image", "show-description"];
  }

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this.render();
    this.loadEvent();
  }

  attributeChangedCallback() {
    this.loadEvent();
  }

  private get eventId() { return this.getAttribute("event-id") || ""; }
  private get apiUrl() { return this.getAttribute("api-url") || ""; }
  private get claimMode() { return (this.getAttribute("claim-mode") || "wallet") as "wallet" | "email" | "both"; }
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

    this.attachListeners();
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
    } else if (mode === "both") {
      submitHtml = `
        <button class="claim-btn" data-wallet-claim="${this.esc(seriesId)}">Claim with wallet</button>
        <button class="claim-btn" data-show-email="${this.esc(seriesId)}" style="margin-left:4px;background:transparent;border:1px solid;color:inherit;">Email</button>
      `;
    } else {
      submitHtml = `<button class="claim-btn" data-wallet-claim="${this.esc(seriesId)}">Claim ticket</button>`;
    }

    return `
      <div class="order-form" data-order-form="${this.esc(seriesId)}">
        ${fieldsHtml}
        <div class="form-actions">
          ${submitHtml}
          <button class="cancel-btn" data-cancel-order="${this.esc(seriesId)}">Cancel</button>
        </div>
        ${st.error ? `<p class="error-msg">${this.esc(st.error)}</p>` : ""}
        <p class="encrypt-note">Your info is encrypted — only the organizer can read it.</p>
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
      if (mode === "wallet") {
        actionHtml = `<button class="claim-btn" data-wallet-claim="${this.esc(s.seriesId)}">Claim ticket</button>`;
      } else if (mode === "email") {
        actionHtml = `<button class="claim-btn" data-show-email="${this.esc(s.seriesId)}">Claim with email</button>`;
      } else {
        // both
        actionHtml = `
          <div>
            <button class="claim-btn" data-wallet-claim="${this.esc(s.seriesId)}">Claim with wallet</button>
            <button class="claim-btn" data-show-email="${this.esc(s.seriesId)}" style="margin-left:4px;background:transparent;border:1px solid;color:inherit;">Email</button>
          </div>
        `;
      }
      if (st?.error) {
        actionHtml += `<p class="error-msg">${this.esc(st.error)}</p>`;
      }
    }

    return `
      <div class="series-card" data-series="${this.esc(s.seriesId)}">
        <div class="series-info">
          <h3>${this.esc(s.name)}</h3>
          <p class="avail">${avail} / ${total} available</p>
        </div>
        ${actionHtml}
      </div>
    `;
  }

  private attachListeners() {
    // Wallet claim buttons — if order form needed, show form first
    this.shadow.querySelectorAll<HTMLButtonElement>("[data-wallet-claim]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sid = btn.getAttribute("data-wallet-claim")!;
        const st = this.seriesStates.get(sid);
        if (this.hasOrderForm && st && !st.orderFormVisible) {
          st.orderFormVisible = true;
          this.render();
          return;
        }
        this.handleWalletClaim(sid);
      });
    });

    // Show email form — if order form needed, show order form with email mode
    this.shadow.querySelectorAll<HTMLButtonElement>("[data-show-email]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sid = btn.getAttribute("data-show-email")!;
        const st = this.seriesStates.get(sid);
        if (st) {
          st.emailMode = true;
          if (this.hasOrderForm && !st.orderFormVisible) {
            st.orderFormVisible = true;
          }
          this.render();
        }
      });
    });

    // Email claim submit
    this.shadow.querySelectorAll<HTMLButtonElement>("[data-email-claim]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sid = btn.getAttribute("data-email-claim")!;
        this.handleEmailClaim(sid);
      });
    });

    // Cancel order form
    this.shadow.querySelectorAll<HTMLButtonElement>("[data-cancel-order]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sid = btn.getAttribute("data-cancel-order")!;
        const st = this.seriesStates.get(sid);
        if (st) {
          st.orderFormVisible = false;
          st.emailMode = false;
          st.orderFormData = {};
          st.error = null;
          this.render();
        }
      });
    });

    // Order form field inputs — sync values to state
    this.shadow.querySelectorAll<HTMLElement>("[data-order-field]").forEach((el) => {
      const attr = el.getAttribute("data-order-field")!;
      const [sid, fieldId] = attr.split(":");
      const st = this.seriesStates.get(sid);
      if (!st) return;

      if (el instanceof HTMLInputElement && el.type === "checkbox") {
        el.addEventListener("change", () => {
          st.orderFormData[fieldId] = el.checked ? "yes" : "";
        });
      } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        el.addEventListener("input", () => {
          st.orderFormData[fieldId] = el.value;
        });
      }
    });
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
        this.render();
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
      this.render();
      return null;
    }
  }

  private async handleWalletClaim(seriesId: string) {
    const st = this.seriesStates.get(seriesId);
    if (!st || st.claiming || !this.api) return;

    st.claiming = true;
    st.error = null;
    this.render();

    // Encrypt order data if form is present
    const encryptedOrder = await this.encryptOrderData(seriesId, st);
    if (encryptedOrder === null) { st.claiming = false; return; }

    const address = await connectWallet();
    if (!address) {
      st.claiming = false;
      st.error = "Wallet not available or connection rejected";
      this.render();
      return;
    }

    try {
      const body: Record<string, unknown> = { mode: "wallet", walletAddress: address };
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
      this.render();
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
      this.render();
      return;
    }

    st.claiming = true;
    st.error = null;
    this.render();

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
      this.render();
    }
  }

  private esc(s: string): string {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }
}
