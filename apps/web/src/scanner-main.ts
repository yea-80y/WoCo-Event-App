import { mount } from "svelte";
import "./scanner.css";
import ScannerApp from "./ScannerApp.svelte";

const app = mount(ScannerApp, {
  target: document.getElementById("app")!,
});

export default app;
