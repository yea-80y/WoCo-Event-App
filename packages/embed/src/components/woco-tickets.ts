import { createApiClient, type ApiClient } from "../api/client.js";
import { connectWallet } from "../auth/wallet.js";
import { getStyles } from "./styles.js";

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

    let actionHtml: string;
    if (st?.claiming) {
      actionHtml = `<button class="claim-btn" disabled>Claiming...</button>`;
    } else if (avail === 0) {
      actionHtml = `<button class="claim-btn" disabled>Sold out</button>`;
    } else if (st?.emailMode) {
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
    // Wallet claim buttons
    this.shadow.querySelectorAll<HTMLButtonElement>("[data-wallet-claim]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sid = btn.getAttribute("data-wallet-claim")!;
        this.handleWalletClaim(sid);
      });
    });

    // Show email form
    this.shadow.querySelectorAll<HTMLButtonElement>("[data-show-email]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sid = btn.getAttribute("data-show-email")!;
        const st = this.seriesStates.get(sid);
        if (st) {
          st.emailMode = true;
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
  }

  private async handleWalletClaim(seriesId: string) {
    const st = this.seriesStates.get(seriesId);
    if (!st || st.claiming || !this.api) return;

    st.claiming = true;
    st.error = null;
    this.render();

    const address = await connectWallet();
    if (!address) {
      st.claiming = false;
      st.error = "Wallet not available or connection rejected";
      this.render();
      return;
    }

    try {
      const resp = await this.api.post<unknown>(
        `/api/events/${this.eventId}/series/${seriesId}/claim`,
        { mode: "wallet", walletAddress: address },
      );

      if (!resp.ok) {
        st.error = (resp.error as string) || "Claim failed";
      } else {
        st.claimedEdition = (resp as Record<string, unknown>).edition as number ?? null;
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

    try {
      const resp = await this.api.post<unknown>(
        `/api/events/${this.eventId}/series/${seriesId}/claim`,
        { mode: "email", email },
      );

      if (!resp.ok) {
        st.error = (resp.error as string) || "Claim failed";
      } else {
        st.claimedEdition = (resp as Record<string, unknown>).edition as number ?? null;
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
