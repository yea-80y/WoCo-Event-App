import { mount } from "svelte";
import "./scanner.css";
import ScannerApp from "./ScannerApp.svelte";
import { scanner } from "./lib/scanner/store.svelte.js";
import { startScannerUpdates } from "./lib/scanner/sw-update.js";

// Before mount: boot asks for a newer version before it sets up a door pass.
startScannerUpdates(() => scanner.newVersionReady());

const app = mount(ScannerApp, {
  target: document.getElementById("app")!,
});

export default app;
