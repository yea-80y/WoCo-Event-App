/**
 * Entry of `woco-seatmap.js`, the embed's seat map frame (the server's
 * /embed/seatmap/:eventId/:seriesId page). Built separately from the 51 KB widget
 * (vite.seatmap.config.ts), so organiser pages without seated events never load it.
 */
import { mount } from "svelte";
import SeatFrame from "./SeatFrame.svelte";
import { originOf } from "../seatmap-bridge.js";
import { frameThemeCss } from "./theme.js";

const root = document.getElementById("seatframe");
if (root) {
  const theme = root.dataset.theme === "light" ? "light" : "dark";
  const style = document.createElement("style");
  style.textContent = frameThemeCss(theme);
  document.head.appendChild(style);
  mount(SeatFrame, {
    target: root,
    props: {
      eventId: root.dataset.event ?? "",
      seriesId: root.dataset.series ?? "",
      host: originOf(root.dataset.host ?? ""),
    },
  });
}
