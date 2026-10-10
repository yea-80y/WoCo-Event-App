/**
 * The hosts Web3Auth v11 contacts from OUR document on the email path, allowed by the
 * app's CSP (vite-plugins/csp.ts, a <meta> policy injected into index.html at build,
 * so it travels to every origin that serves the app: gateway.woco-net.com,
 * woco.eth.limo, event pages built from the same index.html).
 *
 * Read from the installed SDK where it names them, so an upgrade that moves the
 * session service (v11 moved its HTTP side to api.web3auth.io/session-service) fails
 * here instead of in a person's sign-in. The pop-up (passwordless page, Google) is a
 * top-level window with its own policy; the auth.web3auth.io frame's own requests
 * (key shares, metadata) run under ITS origin - neither is ours to allow.
 *
 * MUTATION: drop wss://session.web3auth.io from connect-src and the socket test goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APP_POLICY } from "../vite-plugins/csp.ts";

const constants = readFileSync(
  new URL("../node_modules/@toruslabs/constants/dist/lib.esm/constants.js", import.meta.url),
  "utf8",
);
const production = (map: string): string => {
  const block = constants.slice(constants.indexOf(`const ${map} = {`));
  const m = block.match(/\[BUILD_ENV\.PRODUCTION\]: "([^"]+)"/);
  assert.ok(m, `${map} has a production URL`);
  return m[1];
};
const origin = (url: string) => new URL(url).origin;
const allows = (directive: string, source: string) => APP_POLICY[directive]?.includes(source) ?? false;

test("the session service (HTTP), citadel and signer APIs: allowed in connect-src", () => {
  for (const map of ["STORAGE_SERVER_MAP", "CITADEL_SERVER_MAP"]) {
    const o = origin(production(map));
    assert.equal(o, "https://api.web3auth.io", map);
    assert.ok(allows("connect-src", o), `${map} -> ${o}`);
  }
});

test("the session socket: both its https polling and its wss upgrade are allowed", () => {
  const socket = origin(production("STORAGE_SERVER_SOCKET_URL_MAP"));
  assert.equal(socket, "https://session.web3auth.io");
  assert.ok(allows("connect-src", socket));
  assert.ok(allows("connect-src", socket.replace("https://", "wss://")));
});

test("the sign-in frame, the modal's assets and the captcha it mounts in our document", () => {
  assert.ok(allows("frame-src", "https://auth.web3auth.io"), "the /v11/frame lives here");
  assert.ok(allows("connect-src", "https://assets.web3auth.io"), "wallet registry");
  assert.ok(allows("img-src", "https://images.web3auth.io"), "login-method icons");
  for (const d of ["script-src", "frame-src", "style-src", "connect-src"]) {
    assert.ok(allows(d, "https://hcaptcha.com") && allows(d, "https://*.hcaptcha.com"), `hcaptcha in ${d}`);
  }
  const login = readFileSync(
    new URL("../node_modules/@web3auth/modal/dist/lib.esm/packages/modal/src/ui/containers/Login/Login.js", import.meta.url),
    "utf8",
  );
  assert.ok(login.includes("jsx(HCaptcha, {"), "v11's login screen mounts hCaptcha in our document");
});

test("Segment stays out: analytics disabled, so its hosts are not allowed", () => {
  for (const d of ["script-src", "connect-src"]) {
    assert.ok(!(APP_POLICY[d] ?? []).some((s) => s.includes("segment")), d);
  }
});
