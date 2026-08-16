/**
 * Entry for the public verification page.
 *
 * Its own entry rather than a route in the app, and that is the point: nothing
 * here may reach the auth store, the wallet stack or the router, so the page
 * boots for a reader who has no account and will never make one. It shares only
 * the design tokens.
 *
 * Moving it to its own domain later is a vite config pointing at these three
 * files — the same shape `vite.scanner.config.ts` already uses. Until then it
 * ships in the main collection as `verify.html`, which needs no new deploy step.
 */

import { mount } from "svelte";
import "./app.css";
import VerifyApp from "./VerifyApp.svelte";

const app = mount(VerifyApp, {
  target: document.getElementById("app")!,
});

export default app;
