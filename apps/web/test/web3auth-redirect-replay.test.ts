/**
 * A Web3Auth redirect return replayed END TO END through the REAL SDK: the real
 * `@web3auth/auth` `Auth.init()` (IFRAME sdk mode, redirect ux mode, exactly as
 * the auth connector builds it) on a scripted page and a scripted Web3Auth frame,
 * fed a real-shaped `#b64Params` result that has passed through OUR boot capture
 * and finish URL (web3auth-redirect.ts).
 *
 * The shape is the one the SDK itself writes on the way out
 * (`authConnector.connectWithSocialLogin`: `customState.nonce` +
 * `customState.loginParams = JSON.stringify(loginParams)`, the latter carrying the
 * email as `extraLoginOptions.login_hint`) and reads on the way back
 * (`Auth.init`: `postLoginInitiatedMessage(JSON.parse(params.loginParams),
 * params.nonce)`). Web3Auth's hosted pages are not reachable from CI, so the
 * extra fields here (numbers, objects, an empty namespace) stand in for anything
 * else the hosted page may add.
 *
 * What this proves: our hand-off gives the frame exactly what the SDK reading the
 * raw return URL would - so a finish that fails after it fails inside the SDK /
 * Web3Auth's frame, and the reason must be shown (web3auth-account.ts captures it).
 *
 * MUTATIONS (each went red, then restored): loginParams dropped by the capture;
 * non-string values dropped (the #860 capture).
 */
import test from "node:test";
import assert from "node:assert/strict";

const { Auth, SDK_MODE, UX_MODE, WEB3AUTH_NETWORK, getHashQueryParams } = await import("@web3auth/auth");
const { captureRedirectReturn, urlForFinish, writeRedirectMarker } = await import("../src/lib/auth/web3auth-redirect.ts");

const FRAME_ORIGIN = "https://auth.web3auth.io";

/** What the click-time connector sends (connectWithSocialLogin's loginParams). */
const LOGIN_PARAMS = {
  authConnection: "email_passwordless",
  authConnectionId: "w3a-email-passwordless-demo",
  groupedAuthConnectionId: "",
  loginHint: "someone@example.com",
  extraLoginOptions: { login_hint: "someone@example.com" },
  recordId: "rec-123",
  loginSource: "web3auth-web",
};
const NONCE = "8a1e0f6d2c";

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");

/** A return as Web3Auth's hosted page could write it. */
const RETURN_HASH = `#b64Params=${b64url({
  nonce: NONCE,
  loginParams: JSON.stringify(LOGIN_PARAMS),
  sessionNamespace: "",
  version: 11,
  whiteLabel: { mode: "dark" },
  appState: "",
})}`;

type FrameReply = { type: "login_failed"; error: string } | { type: "silent" };

/** A browser page with a scripted Web3Auth frame. Returns what the frame was sent. */
function installPage(url: string, reply: FrameReply) {
  const listeners = new Set<(e: { origin: string; data: unknown }) => void>();
  const sent: Array<{ type: string; data: { loginConfig?: { params: unknown }; nonce?: string } }> = [];
  const replaced: string[] = [];
  const u = new URL(url);
  const location = {
    get href() {
      return u.href;
    },
    get origin() {
      return u.origin;
    },
    get protocol() {
      return u.protocol;
    },
    get host() {
      return u.host;
    },
    get pathname() {
      return u.pathname;
    },
    get search() {
      return u.search;
    },
    get hash() {
      return u.hash;
    },
  };
  const post = (data: unknown) => setImmediate(() => listeners.forEach((fn) => fn({ origin: FRAME_ORIGIN, data })));
  const document = {
    cookie: "",
    createElement: () => {
      let html = "";
      return {
        set innerHTML(v: string) {
          html = v;
        },
        get content() {
          const src = /src="([^"]+)"/.exec(html)![1];
          const embedNonce = new URLSearchParams(new URL(src).hash.slice(1)).get("nonce");
          const frame = {
            src,
            style: {} as Record<string, string>,
            parentNode: null as unknown,
            contentWindow: {
              postMessage: (msg: { type: string; data: { nonce?: string } }) => {
                sent.push(msg as never);
                if (msg.type === "login_initiated" && reply.type === "login_failed") {
                  post({ type: "login_failed", nonce: embedNonce, data: { error: reply.error } });
                }
              },
            },
            embedNonce,
          };
          return { firstChild: frame };
        },
      };
    },
    body: {
      appendChild: (frame: { parentNode: unknown; embedNonce: string }) => {
        frame.parentNode = document.body;
        post({ type: "setup_complete", nonce: frame.embedNonce });
      },
    },
  };
  const g = globalThis as Record<string, unknown>;
  g.window = {
    location,
    document,
    history: {
      state: null,
      replaceState: (_s: unknown, _t: string, href: string) => {
        replaced.push(href);
        const n = new URL(href, u);
        u.search = n.search;
        u.hash = n.hash;
      },
    },
    addEventListener: (_: string, fn: never) => listeners.add(fn),
    removeEventListener: (_: string, fn: never) => listeners.delete(fn),
    matchMedia: () => ({ matches: false }),
  };
  g.document = document;
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  return { sent, replaced, location };
}

function uninstallPage() {
  for (const k of ["window", "document", "localStorage"]) delete (globalThis as Record<string, unknown>)[k];
}

/** The Auth the connector builds for a redirect-mode instance (authConnector.init). */
const connectorAuth = () =>
  new Auth({
    clientId: "BPi5_test_client",
    network: WEB3AUTH_NETWORK.SAPPHIRE_MAINNET,
    sdkMode: SDK_MODE.IFRAME,
    uxMode: UX_MODE.REDIRECT,
    replaceUrlOnRedirect: true,
    redirectUrl: "https://woco.eth.limo/",
    authConnectionConfig: [],
  });

/** The URL our finish builds the SDK at, from the URL the page was loaded at. */
function finishUrlFor(returnUrl: string): string {
  const tab = new Map<string, string>();
  const storage = { getItem: (k: string) => tab.get(k) ?? null, setItem: (k: string, v: string) => void tab.set(k, v), removeItem: (k: string) => void tab.delete(k) };
  writeRedirectMarker(storage, "#/event/abc", 1_000);
  const u = new URL(returnUrl);
  const out = captureRedirectReturn({ pathname: u.pathname, search: u.search, hash: u.hash }, storage, 2_000);
  assert.equal(out.kind, "finish");
  if (out.kind !== "finish") throw new Error("unreachable");
  return new URL(urlForFinish(u.pathname, "", out.pending), u.origin).href;
}

async function initAt(url: string, reply: FrameReply) {
  const page = installPage(url, reply);
  try {
    const outcome = await connectorAuth()
      .init()
      .then(
        () => ({ ok: true as const }),
        (e: unknown) => ({ ok: false as const, error: e }),
      );
    return { ...page, outcome };
  } finally {
    uninstallPage();
  }
}

const loginInitiated = (sent: Array<{ type: string; data: { loginConfig?: { params: unknown }; nonce?: string } }>) =>
  sent.find((m) => m.type === "login_initiated");

test("replay: the frame gets EXACTLY the loginParams and nonce the click sent - the same as the SDK reading the raw return", async () => {
  const raw = await initAt(`https://woco.eth.limo/${RETURN_HASH}`, { type: "login_failed", error: "x" });
  const ours = await initAt(finishUrlFor(`https://woco.eth.limo/${RETURN_HASH}`), { type: "login_failed", error: "x" });
  const a = loginInitiated(raw.sent);
  const b = loginInitiated(ours.sent);
  assert.ok(a && b, "both reach the frame");
  assert.deepEqual(b!.data.loginConfig!.params, LOGIN_PARAMS);
  assert.equal(b!.data.nonce, NONCE);
  assert.deepEqual(b!.data.loginConfig!.params, a!.data.loginConfig!.params, "identical to the SDK's own reading");
  assert.equal(b!.data.nonce, a!.data.nonce);
});

test("replay: when Web3Auth's frame refuses, Auth.init rejects with ITS reason (which the modal then only logs)", async () => {
  const r = await initAt(finishUrlFor(`https://woco.eth.limo/${RETURN_HASH}`), {
    type: "login_failed",
    error: "Some reason Web3Auth's frame gives",
  });
  assert.equal(r.outcome.ok, false);
  assert.equal((r.outcome as { error: unknown }).error, "Some reason Web3Auth's frame gives");
  // The SDK's clean-up took the result out of the bar.
  assert.equal(r.location.hash, "");
});

test("replay: a return with no loginParams fails inside Auth.init before the frame is asked (JSON.parse of undefined)", async () => {
  const hash = `#b64Params=${b64url({ nonce: NONCE })}`;
  const r = await initAt(finishUrlFor(`https://woco.eth.limo/${hash}`), { type: "silent" });
  assert.equal(r.outcome.ok, false);
  assert.equal((r.outcome as { error: Error }).error.name, "SyntaxError");
  assert.equal(loginInitiated(r.sent), undefined);
});

test("replay: the SDK's own parser reads EVERY field, with its type, the same from our finish URL as from the raw return", () => {
  const read = (url: string) => {
    installPage(url, { type: "silent" });
    try {
      return getHashQueryParams(false);
    } finally {
      uninstallPage();
    }
  };
  const raw = read(`https://woco.eth.limo/${RETURN_HASH}`);
  const ours = read(finishUrlFor(`https://woco.eth.limo/${RETURN_HASH}`));
  assert.deepEqual(ours, raw);
  assert.equal(typeof ours.version, "number", "non-string values are handed over as they came");
  assert.deepEqual(ours.whiteLabel, { mode: "dark" });
});
