import { WocoTickets } from "./components/woco-tickets.js";

if (!customElements.get("woco-tickets")) {
  customElements.define("woco-tickets", WocoTickets);
}

export { WocoTickets };
