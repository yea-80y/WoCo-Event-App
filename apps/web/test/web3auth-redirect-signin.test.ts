/**
 * The redirect sign-in (iPhone/iPad) through the REAL `web3auth-account.ts`, on a
 * fake SDK and a scripted address bar: the click leaves with a marker and the
 * route intact; the return is finished only as a session it MADE (#182), with
 * the address bar always put back; the pop-up path is untouched.
 *
 * MUTATIONS (each went red, then restored): marker written after connect(); the
 * click-time build's URL not put back; the cancel not clearing the marker; the
 * session-id comparison dropped (survivor adopted); `error` built instead of
 * refused; the finish's URL not restored on failure; the finish built in pop-up mode;
 * the start-up wait not waiting (slow start); the late failure reason not waited for.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { privateKeyToAccount } from "viem/accounts";

await import("@web3auth/modal");

const memory = new Map<string, string>();
const lsStore = {
  get length() {
    return memory.size;
  },
  key: (i: number) => [...memory.keys()][i] ?? null,
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
};
(globalThis as unknown as { localStorage: typeof lsStore }).localStorage = lsStore;

const { loginWithWeb3Auth, cancelWeb3AuthSignIn, finishWeb3AuthRedirectSignIn, setWeb3AuthFactoryForTests } = await import(
  "../src/lib/auth/web3auth-account.js"
);
const { SURVIVOR_INTERFERED_MESSAGE } = await import("../src/lib/auth/web3auth-survivor.js");
const { isWeb3AuthSignInError } = await import("../src/lib/auth/web3auth-signin-error.js");
const { signInFailureCode } = await import("../src/lib/auth/signin-failure.js");
const { REDIRECT_MARKER_KEY } = await import("../src/lib/auth/web3auth-redirect.js");
type Mode = import("../src/lib/auth/web3auth-redirect.js").Web3AuthUxMode;
type Pending = import("../src/lib/auth/web3auth-redirect.js").PendingRedirect;

const KEY_NEW = "33".repeat(32);
const KEY_OLD = "44".repeat(32);
const addressOf = (k: string) => privateKeyToAccount(`0x${k}`).address.toLowerCase();
const SESSION_KEY = "auth_store:session_id";

/** The address bar and the tab's storage. */
class Page {
  url = new URL("https://woco.eth.limo/#/event/abc");
  replaced: string[] = [];
  tab = new Map<string, string>();
  mode: Mode = "redirect";
  deps = () => ({
    uxMode: () => this.mode,
    tabStorage: () => ({
      getItem: (k: string) => this.tab.get(k) ?? null,
      setItem: (k: string, v: string) => void this.tab.set(k, v),
      removeItem: (k: string) => void this.tab.delete(k),
    }),
    sdkStorage: () => lsStore,
    location: () => ({ pathname: this.url.pathname, search: this.url.search, hash: this.url.hash }),
    replaceUrl: (u: string) => {
      this.replaced.push(u);
      this.url = new URL(u, this.url);
    },
    now: () => 1_800_000_000_000,
    settleTimeoutMs: 1_000,
  });
  get path() {
    return `${this.url.pathname}${this.url.search}${this.url.hash}`;
  }
}

class FakeSdk extends EventEmitter {
  connected = false;
  status = "not_ready";
  provider: { request: () => Promise<unknown> } | null = null;
  cachedConnector: string | null = null;
  connectCalls = 0;
  logouts = 0;
  sawSearch = "";
  sawHash = "";
  pendingConnect: { reject: (e: Error) => void } | null = null;
  loginModal = {
    closeModal: () => {
      this.pendingConnect?.reject(new Error("User closed the modal"));
      this.pendingConnect = null;
    },
  };
  constructor(
    readonly mode: Mode,
    private world: World,
  ) {
    super();
  }
  async init(): Promise<void> {
    this.provider = { request: async () => { throw new Error("no session"); } };
    if (this.mode !== "redirect" || !this.world.slowStart) return this.start();
    // The real modal: init() resolves while its connectors are still starting, in a
    // handler it does not await; the URL is read, and the session made, later.
    setImmediate(() => {
      this.status = "connecting";
      setImmediate(() => void this.start());
    });
  }
  private async start(): Promise<void> {
    this.status = "ready";
    if (this.mode !== "redirect") return;
    // Auth.init: read the URL, then the replaceUrlOnRedirect clean-up mangles the fragment.
    const page = this.world.page;
    this.sawSearch = page.url.search;
    this.sawHash = page.url.hash;
    const b64 = new URLSearchParams(page.url.hash.slice(1)).get("b64Params") ?? page.url.searchParams.get("b64Params");
    page.deps().replaceUrl(`${page.url.pathname}#${encodeURIComponent(page.url.hash.slice(1))}=`);
    if (this.world.lateFailure) {
      // The modal sets its status, awaits a cache clear, THEN re-emits the reason.
      this.status = "errored";
      setTimeout(() => this.emit("errored", Object.assign(new Error("Failed to login with auth"), { name: "WalletLoginError", code: 5111 })), 180); // after the start-up wait's first status poll (100 ms)
      return;
    }
    let result: Record<string, string> = {};
    if (b64) result = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    const stored = memory.get(SESSION_KEY);
    if (result.sessionId) memory.set(SESSION_KEY, result.sessionId);
    else if (result.nonce && !stored) memory.set(SESSION_KEY, `frame-${result.nonce}`);
    const live = memory.get(SESSION_KEY);
    if (!live || this.world.noSession) return;
    // isRedirectResult: the connector connects whatever session is stored now.
    const key = live === this.world.oldSessionId ? KEY_OLD : KEY_NEW;
    this.connected = true;
    this.status = "connected";
    this.cachedConnector = "auth";
    this.provider = { request: async () => key };
    this.emit("connected", { reconnected: true });
  }
  async connect() {
    this.connectCalls++;
    if (this.mode === "redirect") {
      // window.location.replace(...): this page is leaving; nothing settles unless the modal closes first.
      this.world.navigatedWith = new Map(this.world.page.tab);
      return new Promise<never>((_, reject) => {
        this.pendingConnect = { reject };
      });
    }
    this.connected = true;
    this.status = "connected";
    const p = { request: async () => KEY_NEW };
    this.provider = p;
    return p;
  }
  async logout(): Promise<void> {
    this.logouts++;
    this.connected = false;
    this.status = "ready";
    this.cachedConnector = null;
    memory.delete(SESSION_KEY);
  }
  async getUserInfo() {
    return {};
  }
}

class World {
  page = new Page();
  built: FakeSdk[] = [];
  oldSessionId: string | null = null;
  noSession = false;
  /** init() resolves before the connector has started (the real modal's shape). */
  slowStart = false;
  /** The connector fails, its status set before its reason is emitted. */
  lateFailure = false;
  navigatedWith: Map<string, string> | null = null;
  install(): void {
    setWeb3AuthFactoryForTests(
      async (mode) => {
        const sdk = new FakeSdk(mode, this);
        this.built.push(sdk);
        await sdk.init();
        return sdk;
      },
      () => ({ listen: () => () => {}, watching: () => false, setInterval: () => ({}), clearInterval: () => {} }),
      this.page.deps,
    );
  }
}

let world: World;
beforeEach(() => {
  memory.clear();
  world = new World();
  world.install();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

const pending = (params: Record<string, string>, notes: string[] = []): Pending => ({ params, notes, route: "#/event/abc" });

// --- leaving ----------------------------------------------------------------------

test("the click: a redirect-mode instance, the marker written BEFORE connect(), and the route put back after the SDK mangled it", async () => {
  void loginWithWeb3Auth().catch(() => {});
  await settle();
  const sdk = world.built[0];
  assert.equal(sdk.mode, "redirect");
  assert.equal(world.page.replaced[0], "/", "built at the bare path: nothing of ours for the SDK to read");
  assert.equal(world.page.path, "/#/event/abc", "the route is back after the build");
  assert.equal(sdk.connectCalls, 1);
  const marker = JSON.parse(world.navigatedWith?.get(REDIRECT_MARKER_KEY) ?? "null");
  assert.deepEqual(marker, { v: 1, at: 1_800_000_000_000, route: "#/event/abc" }, "in storage when the tab leaves");
  assert.ok(world.page.tab.has(REDIRECT_MARKER_KEY), "kept while the page navigates away");
});

test("closing the sheet before choosing: a quiet cancel, and the marker is spent", async () => {
  const attempt = loginWithWeb3Auth();
  await settle();
  cancelWeb3AuthSignIn();
  await assert.rejects(attempt, (e: unknown) => isWeb3AuthSignInError(e) && e.cancelled);
  assert.equal(world.page.tab.has(REDIRECT_MARKER_KEY), false);
  assert.equal(world.page.path, "/#/event/abc");
});

test("desktop/Android: the pop-up as before - no marker, the address bar never touched", async () => {
  world.page.mode = "popup";
  const r = await loginWithWeb3Auth();
  assert.equal(r.address, addressOf(KEY_NEW));
  assert.equal(world.built[0].mode, "popup");
  assert.deepEqual(world.page.replaced, []);
  assert.equal(world.page.tab.size, 0);
});

// --- coming back --------------------------------------------------------------------

test("the return: built in redirect mode at ?b64Params=, the NEW session's key, and the clean route after", async () => {
  world.page.url = new URL("https://woco.eth.limo/#/event/abc");
  const r = await finishWeb3AuthRedirectSignIn(pending({ sessionId: "0xnew" }, ["r.b64", "r.sid"]));
  assert.equal(r.address, addressOf(KEY_NEW));
  const sdk = world.built[0];
  assert.equal(sdk.mode, "redirect");
  assert.match(sdk.sawHash, /^#b64Params=[A-Za-z0-9_-]+$/, "the SDK read the result from the fragment");
  assert.equal(sdk.sawSearch, "", "never from the query, which rides out as Referer");
  assert.equal(world.page.path, "/#/event/abc", "no result and no mangled fragment left behind");
  assert.equal(memory.get("woco:web3auth-session-established"), "1");
});

test("the return over a stored session the SDK connects instead (nonce shape skips the frame): ended, never adopted (#182)", async () => {
  memory.set(SESSION_KEY, "0xold");
  world.oldSessionId = "0xold";
  await assert.rejects(finishWeb3AuthRedirectSignIn(pending({ nonce: "n1", loginParams: "{}" }, ["r.nonce"])), (e: unknown) => {
    assert.ok(isWeb3AuthSignInError(e));
    assert.equal((e as Error).message, SURVIVOR_INTERFERED_MESSAGE);
    return true;
  });
  assert.equal(world.built[0].logouts, 1, "the survivor is ended");
  assert.equal(world.page.path, "/#/event/abc");
});

test("the return over a stale stored id: a NEW id is this result's own, and it signs in", async () => {
  memory.set(SESSION_KEY, "0xstale");
  const r = await finishWeb3AuthRedirectSignIn(pending({ sessionId: "0xfresh" }));
  assert.equal(r.address, addressOf(KEY_NEW));
});

test("Web3Auth said no (error in the result): refused without building, coded, route restored", async () => {
  world.page.url = new URL("https://woco.eth.limo/?b64Params=x#/event/abc");
  let caught: unknown;
  await finishWeb3AuthRedirectSignIn(pending({ error: "user cancelled", state: "s" }, ["r.b64", "r.err"])).catch((e) => (caught = e));
  assert.ok(caught);
  assert.equal(world.built.length, 0);
  assert.equal(world.page.path, "/#/event/abc");
  const code = signInFailureCode(caught, { step: "sdk", elapsedMs: 0 });
  assert.match(code, /^W3A-connect-.*-redirect-r\.b64-r\.err$/);
  assert.ok(!code.includes("cancelled"), "the reason is described, never copied");
});

test("a return that opens no session: coded as the connect step with the SDK's status, route restored", async () => {
  world.noSession = true;
  let caught: unknown;
  await finishWeb3AuthRedirectSignIn(pending({ sessionId: "0xnew" }, ["r.sid"])).catch((e) => (caught = e));
  assert.ok(caught);
  assert.match(signInFailureCode(caught, { step: "sdk", elapsedMs: 0 }), /^W3A-connect-.*-redirect-r\.sid-st\.ready$/);
  assert.equal(world.page.path, "/#/event/abc");
});

test("unreadable SDK storage fails closed before anything is built", async () => {
  setWeb3AuthFactoryForTests(
    async () => {
      throw new Error("must not build");
    },
    undefined,
    () => ({ ...world.page.deps(), sdkStorage: () => null }),
  );
  await assert.rejects(finishWeb3AuthRedirectSignIn(pending({ sessionId: "0xnew" })));
  assert.equal(world.page.path, "/#/event/abc");
});

test("the real start-up shape: init() resolves before the connector has read the URL - the route goes back only after it did", async () => {
  world.slowStart = true;
  const r = await finishWeb3AuthRedirectSignIn(pending({ sessionId: "0xnew" }));
  assert.equal(r.address, addressOf(KEY_NEW));
  assert.match(world.built[0].sawHash, /^#b64Params=/, "the result was still in the URL when the connector read it");
  assert.equal(world.page.path, "/#/event/abc", "and the route came back after, over the SDK's mangling");
});

test("a start-up that fails with its status set BEFORE the reason is emitted still carries the SDK's reason", async () => {
  world.slowStart = true;
  world.lateFailure = true;
  let caught: unknown;
  await finishWeb3AuthRedirectSignIn(pending({ nonce: "n1", loginParams: "{}" }, ["r.nonce"])).catch((e) => (caught = e));
  assert.match(signInFailureCode(caught, { step: "sdk", elapsedMs: 0 }), /^W3A-connect-WalletLoginError\.5111-.*-redirect-r\.nonce-st\.errored$/);
  assert.equal(world.page.path, "/#/event/abc");
});
