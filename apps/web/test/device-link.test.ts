/**
 * Linking another device (#746 step 4, Fable consult 7): the new device shows a
 * code, the main device scans it.
 *
 * Both halves run against each other through an in-memory mailbox, with the real
 * code, channel and sealed box; only the passkey, the grant and the sign-in are
 * stand-ins. What these pin:
 *  - the messages: an offer carries only an address, a credential hash and a
 *    one-pairing key; anything else is refused;
 *  - the new device: offer filed before the code is shown; signs in only with what
 *    the main sealed for it, and keeps nothing before that sign-in succeeds;
 *  - the main: the grant before the answer, never to itself, and no answer when
 *    the grant is refused;
 *  - the auth store: a passkey sheet every time on the main, whatever the window;
 *  - the screens: WoCo's own scanner only, nothing the other device wrote shown on
 *    the confirm, no camera until asked for.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LINK_CODE_UNKNOWN,
  LINK_CODE_UNREADABLE,
  parseLinkAnswer,
  parseLinkOffer,
  readPairingOffer,
  runApproveDeviceLink,
  runLinkThisDevice,
  type LinkingPasskey,
  type LinkOffer,
} from "../src/lib/auth/device-link.ts";
import {
  PairingExpiredError,
  formatPairingCode,
  newPairingCode,
  newPairingRecipient,
  pairingChannel,
  parsePairingCode,
  sealLinkSecret,
  type PairingTransport,
} from "../src/lib/auth/pairing-channel.ts";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const offer = {
  v: 1,
  kind: "link",
  grantee: "0x" + "ab".repeat(20),
  credentialTag: "0x" + "cd".repeat(32),
  recipientPk: "ef".repeat(1216),
};

test("offer: exactly the expected fields, lowercase, a full-size key", () => {
  assert.deepEqual(parseLinkOffer(offer), offer);
  assert.deepEqual(parseLinkOffer({ ...offer, extra: "dropped", label: "Someone's laptop" }), offer);
  for (const change of [
    { v: 2 },
    { kind: "make-main" },
    { grantee: offer.grantee.toUpperCase().replace("0X", "0x") },
    { grantee: "0x" + "ab".repeat(19) },
    { credentialTag: "0x" + "cd".repeat(31) },
    { recipientPk: "ef".repeat(1215) },
    { recipientPk: "EF".repeat(1216) },
  ]) {
    assert.equal(parseLinkOffer({ ...offer, ...change }), null, JSON.stringify(Object.keys(change)));
  }
  assert.equal(parseLinkOffer(null), null);
  assert.equal(parseLinkOffer([offer]), null);
});

test("answer: a sealed box object, nothing else", () => {
  const sealed = { v: 2, enc: "00", ct: "00" };
  assert.deepEqual(parseLinkAnswer({ v: 1, kind: "link", sealed }), { v: 1, kind: "link", sealed });
  assert.equal(parseLinkAnswer({ v: 1, kind: "link", sealed: "x" }), null);
  assert.equal(parseLinkAnswer({ v: 1, kind: "link" }), null);
  assert.equal(parseLinkAnswer({ v: 1, kind: "other", sealed }), null);
});

// ---------------------------------------------------------------------------
// Both halves
// ---------------------------------------------------------------------------

const PARENT = "0x" + "12".repeat(20);
const MAIN = "0x" + "34".repeat(20);
const SEED = "56".repeat(32);

const laptop: LinkingPasskey = {
  address: "0x" + "9A".repeat(20),
  privateKey: "0x" + "01".repeat(32),
  prfSecret: "02".repeat(32),
  credentialId: "AAECAwQFBgcICQ",
  attachment: "platform",
  handleKind: "added",
};

interface Mailbox extends PairingTransport {
  log: string[];
  /** Resolves a read of `slot` only once this settles - so the run is deterministic. */
  hold?: Promise<unknown>;
  tamper?: (slot: string, box: string) => string;
}

function mailbox(): Mailbox {
  const slots = new Map<string, string>();
  const m: Mailbox = {
    log: [],
    async post(id, slot, box) {
      if (slots.has(`${id}/${slot}`)) throw new PairingExpiredError();
      m.log.push(`post:${slot}`);
      slots.set(`${id}/${slot}`, box);
    },
    async read(id, slot) {
      if (slot === "answer") await m.hold;
      const box = slots.get(`${id}/${slot}`) ?? null;
      return box && m.tamper ? m.tamper(slot, box) : box;
    },
  };
  return m;
}

/** Run the new device; when it shows its code, run the main as the person would. */
function linkBothSides(
  m: Mailbox,
  main: Partial<Parameters<typeof runApproveDeviceLink>[2]> = {},
  newSide: { signIn?: () => Promise<void> } = {},
) {
  const calls: string[] = [];
  const signedIn: Array<{ parent: string; seed: string }> = [];
  let mainDone: Promise<void> = Promise.resolve();
  let shown!: () => void;
  const codeShown = new Promise<void>((r) => (shown = r));
  // A main that fails leaves the new device waiting out the code; end it then.
  const stop = new AbortController();
  const newDevice = runLinkThisDevice(
    {
      signal: stop.signal,
      onCode: ({ typed }) => {
        calls.push("code-shown");
        mainDone = (async () => {
          const { code, offer: read } = await readPairingOffer(typed, { apiBase: "", transport: m });
          assert.equal(read.kind, "link");
          const got = read as LinkOffer;
          calls.push(`offer:${got.grantee}`);
          await runApproveDeviceLink(code, got, {
            apiBase: "",
            parent: PARENT,
            self: MAIN,
            seed: SEED,
            transport: m,
            grant: async (grantee) => {
              m.log.push(`grant:${grantee}`);
            },
            revoke: async (grantee) => {
              m.log.push(`revoke:${grantee}`);
            },
            ...main,
          });
        })();
        m.hold = mainDone.catch(() => stop.abort());
        shown();
      },
    },
    {
      apiBase: "",
      transport: m,
      passkey: async () => laptop,
      signIn: async (_account, secret) => {
        await newSide.signIn?.();
        calls.push("signed-in");
        signedIn.push(secret);
      },
      settle: async () => {
        calls.push("settled");
      },
    },
  );
  return { newDevice, main: async () => { await codeShown; return mainDone; }, calls, signedIn };
}

test("link: the new device signs in with exactly what the main sealed for it, after the grant", async () => {
  const m = mailbox();
  const run = linkBothSides(m);
  await run.newDevice;
  await run.main();
  assert.deepEqual(run.signedIn, [{ parent: PARENT, seed: SEED }]);
  assert.deepEqual(m.log, ["post:offer", `grant:${laptop.address.toLowerCase()}`, "post:answer"]);
  assert.deepEqual(run.calls, ["code-shown", `offer:${laptop.address.toLowerCase()}`, "signed-in", "settled"]);
});

test("link: an answer that was not sealed under this code is refused, and nothing is kept", async () => {
  const m = mailbox();
  const other = pairingChannel(parsePairingCode("0".repeat(26))!);
  const forged = await other.seal("answer", { v: 1, kind: "link", sealed: { v: 2, enc: "00", ct: "00" } });
  m.tamper = (slot, box) => (slot === "answer" ? forged : box);
  const run = linkBothSides(m);
  await assert.rejects(run.newDevice, { message: LINK_CODE_UNKNOWN });
  assert.deepEqual(run.signedIn, []);
  assert.ok(!run.calls.includes("settled"));
});

test("link: right code, but the seed sealed to anyone else's key - refused in the same words", async () => {
  const m = mailbox();
  let signedIn = false;
  const run = runLinkThisDevice(
    {
      onCode: ({ typed }) => {
        m.hold = (async () => {
          const ch = pairingChannel(parsePairingCode(typed)!);
          const stranger = newPairingRecipient();
          const sealed = await sealLinkSecret(stranger.publicKeyHex, { parent: PARENT, seed: SEED }, { id: ch.id, grantee: laptop.address });
          await m.post(ch.id, "answer", await ch.seal("answer", { v: 1, kind: "link", sealed }));
        })();
      },
    },
    { apiBase: "", transport: m, passkey: async () => laptop, signIn: async () => { signedIn = true; } },
  );
  await assert.rejects(run, { message: LINK_CODE_UNKNOWN });
  assert.equal(signedIn, false);
});

test("link: a refused sign-in keeps nothing", async () => {
  const run = linkBothSides(mailbox(), {}, {
    signIn: async () => {
      throw new Error("This device was removed from the account");
    },
  });
  await assert.rejects(run.newDevice, /removed/);
  assert.deepEqual(run.signedIn, []);
  assert.ok(!run.calls.includes("settled"));
});

test("main: no answer when the grant is refused; never a grant to itself", async () => {
  const m = mailbox();
  const run = linkBothSides(m, {
    grant: async () => {
      throw new Error("This account already has 10 added passkeys. Remove one first.");
    },
  });
  // The new device would wait out the code; stop it once the main has failed.
  await assert.rejects(run.main(), /already has 10/);
  assert.deepEqual(m.log, ["post:offer"]);

  const m2 = mailbox();
  const run2 = linkBothSides(m2, { self: laptop.address });
  await assert.rejects(run2.main(), /from this device/);
  assert.deepEqual(m2.log, ["post:offer"]);
  await assert.rejects(run.newDevice, { name: "AbortError" });
  await assert.rejects(run2.newDevice, { name: "AbortError" });
});

test("main: an answer that certainly never arrived takes its grant back; one that may have, does not", async () => {
  const real = { ...offer, recipientPk: newPairingRecipient().publicKeyHex };
  const offerFor = async () => {
    const m = mailbox();
    const one = newPairingCode();
    const ch = pairingChannel(one);
    await m.post(ch.id, "offer", await ch.seal("offer", real));
    return { m, one };
  };
  for (const [error, revokes] of [[new PairingExpiredError(), true], [new Error("offline"), false]] as const) {
    const { m, one } = await offerFor();
    const log: string[] = [];
    const run = runApproveDeviceLink(one, real as LinkOffer, {
      apiBase: "",
      parent: PARENT,
      self: MAIN,
      seed: SEED,
      transport: { ...m, post: async () => { throw error; } },
      grant: async (g) => void log.push(`grant:${g}`),
      revoke: async (g) => void log.push(`revoke:${g}`),
    });
    await assert.rejects(run, revokes ? /code expired/ : /remove it from Your passkeys/);
    assert.deepEqual(log, revokes ? [`grant:${offer.grantee}`, `revoke:${offer.grantee}`] : [`grant:${offer.grantee}`]);
  }
});

test("main: a code that is not ours, expired, or carries something else is refused before any confirm", async () => {
  const m = mailbox();
  await assert.rejects(readPairingOffer("not a code", { apiBase: "", transport: m }), { message: LINK_CODE_UNREADABLE });
  await assert.rejects(readPairingOffer("0".repeat(26), { apiBase: "", transport: m }), PairingExpiredError);
  await assert.rejects(readPairingOffer("0".repeat(26), { apiBase: "", transport: { ...m, read: async () => "gone" } }), PairingExpiredError);
  const one = newPairingCode();
  const ch = pairingChannel(one);
  await m.post(ch.id, "offer", await ch.seal("offer", { ...offer, kind: "make-main" }));
  await assert.rejects(readPairingOffer(formatPairingCode(one), { apiBase: "", transport: m }), { message: LINK_CODE_UNKNOWN });
  const two = newPairingCode();
  await m.post(pairingChannel(two).id, "offer", "AAAA");
  await assert.rejects(readPairingOffer(formatPairingCode(two), { apiBase: "", transport: m }), { message: LINK_CODE_UNKNOWN });
});

test("new device: cancelling while waiting signs in to nothing", async () => {
  const ac = new AbortController();
  const m = mailbox();
  m.hold = new Promise(() => {});
  let signedIn = false;
  const run = runLinkThisDevice(
    { onCode: () => queueMicrotask(() => ac.abort()), signal: ac.signal },
    {
      apiBase: "",
      transport: { ...m, read: async (id, slot) => (slot === "answer" ? null : m.read(id, slot)) },
      passkey: async () => laptop,
      signIn: async () => {
        signedIn = true;
      },
    },
  );
  await assert.rejects(run, { name: "AbortError" });
  assert.equal(signedIn, false);
});

// ---------------------------------------------------------------------------
// The auth store and the screens
// ---------------------------------------------------------------------------

const STORE = read("../src/lib/auth/auth-store.svelte.ts");
function body(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  return src.slice(start, src.indexOf("\n}\n", start));
}

test("store: a passkey sheet every time on the main; the new device never links while signed in", () => {
  const fresh = body(STORE, "async function _freshMainPasskey(");
  assert.match(fresh, /if \(_kind !== "passkey" \|\| _deviceRole \|\| !_seedAddress\) throw new MainPasskeyRequiredError\(\);/);
  // With the key already in memory there is no silent path: it asks again and checks the answer.
  assert.match(fresh, /\} else \{\s*const material = await restorePasskeyAccount\(\{ retryDiscoverable: false \}\)\.catch\(\(e\) => \{\s*throw asCeremonyCancel\(e\);\s*\}\);\s*if \(material\.address\.toLowerCase\(\) !== _seedAddress\.toLowerCase\(\)\)/);
  assert.doesNotMatch(fresh, /ensureOrganiserUnlock/);
  const approve = body(STORE, "async function approveDeviceLink(");
  assert.ok(approve.indexOf("await _freshMainPasskey();") < approve.indexOf("runApproveDeviceLink"));
  assert.match(body(STORE, "async function linkThisDevice("), /if \(isConnected\) throw new Error/);
});

test("new device: a reload asks for the same passkey; only its id is kept, and a decline never opens a second sheet", () => {
  const LINK = read("../src/lib/auth/device-link.ts");
  const b = body(LINK, "export async function pairingPasskey(");
  assert.match(b, /retryDiscoverable: false,\s*credential: passkeyHandleOnThisOrigin\(pending\.credentialId, pending\.provider\)/);
  assert.match(b, /catch \(e\) \{[\s\S]*?writePairingCredential\(null\);\s*throw asCeremonyCancel\(e\);/);
  const write = body(LINK, "function writePairingCredential(");
  assert.match(write, /sessionStorage/);
  assert.doesNotMatch(write, /localStorage|prf|privateKey/i);
});

const LINK_ANOTHER = read("../src/lib/components/passkeys/LinkAnotherDevice.svelte");
const LINK_THIS = read("../src/lib/components/passkeys/LinkThisDevice.svelte");

test("main screen: WoCo's scanner only, one code at a time, no camera until asked, nothing from the other device on the confirm", () => {
  assert.match(LINK_ANOTHER, /if \(data\.trim\(\)\.toLowerCase\(\)\.startsWith\("woco-pair:"\)\) void use\(data\);/);
  assert.match(LINK_ANOTHER, /if \(stage !== "scan" \|\| inFlight\) return;\s*inFlight = true;/);
  assert.match(LINK_ANOTHER, /const loadCamera = \(\) => import\("\.\.\/\.\.\/scanner\/QrCamera\.svelte"\);/);
  assert.doesNotMatch(LINK_ANOTHER, /^\s*import\s+QrCamera/m);
  assert.match(LINK_ANOTHER, /\{#if camera\}/);
  const markup = LINK_ANOTHER.slice(LINK_ANOTHER.indexOf("</script>"));
  assert.doesNotMatch(markup, /\{[^}]*(pending|offer)[^}]*\}/);
  assert.doesNotMatch(LINK_ANOTHER + LINK_THIS, /href=/);
});

test("new device screen: leaving it ends the wait; a signed-in device is not offered a link", () => {
  assert.match(LINK_THIS, /\$effect\(\(\) => \(\) => controller\?\.abort\(\)\);/);
  assert.match(LINK_THIS, /\{#if auth\.isConnected && stage !== "done"\}/);
  assert.match(read("../src/lib/router/router.svelte.ts"), /if \(path === "\/link"\) return \{ route: "link"/);
  assert.match(read("../src/AttendeeApp.svelte"), /const loadLinkThisDevice = \(\) => import\("\.\/lib\/components\/passkeys\/LinkThisDevice\.svelte"\);/);
});

test("linking has its own screens, each loaded only when opened", () => {
  const your = read("../src/lib/components/passkeys/YourPasskeys.svelte");
  assert.doesNotMatch(your, /^\s*import\s+LinkAnotherDevice/m);
  assert.match(your, /const loadLinkAnotherDevice = \(\) => import\("\.\/LinkAnotherDevice\.svelte"\);/);
});

test("sign-in sheet: the link entry closes the sheet and opens its own screen", () => {
  assert.match(read("../src/lib/components/auth/PasskeyLogin.svelte"), /\{#if onlink\}/);
  assert.match(read("../src/lib/components/auth/LoginModal.svelte"), /onlink=\{\(\) => \{ close\(\); navigate\("\/link"\); \}\}/);
});
