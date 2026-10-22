/**
 * The Web3Auth modal wears WoCo's surfaces and type (owner 2026-10-22). Its options
 * set only the accent (web3auth-config.ts WEB3AUTH_LOOK); the greys and font are
 * custom properties the SDK declares on its own container, which app.css re-declares
 * with a selector that outranks the SDK's. An SDK upgrade that renames the container,
 * moves the greys or adds a :not() would quietly bring the stock navy back - these
 * fail first.
 *
 * MUTATIONS (each went red, then restored): one :not() dropped from ours; the id
 * selector swapped for the class; a grey set to a hex instead of a token.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const sdkCss = read("../node_modules/@web3auth/modal/dist/lib.esm/packages/modal/src/ui/css/index.css.js");
const loginModal = read("../node_modules/@web3auth/modal/dist/lib.esm/packages/modal/src/ui/loginModal.js");
const appCss = read("../src/app.css");

const GREYS = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900"].map((n) => `--app-gray-${n}`);
// The bundled CSS is a JS string literal, so its `#\#` reads `#\\#` in the source.
const SDK_NOT = ":not(#\\\\#)";
const OUR_NOT = ":not(#\\#)";

/** [ids, classes] of a selector made of one id or class plus `:not(#x)`s. */
function specificity(selector: string, not: string): [number, number] {
  const nots = selector.split(not).length - 1;
  const head = selector.replaceAll(not, "");
  return [nots + (head.startsWith("#") ? 1 : 0), head.startsWith(".") ? 1 : 0];
}

function sdkRuleDeclaring(prop: string): { selector: string; body: string } {
  const at = sdkCss.indexOf(`${prop}:`);
  assert.ok(at > 0, `the SDK no longer declares ${prop}`);
  const open = sdkCss.lastIndexOf("{", at);
  const selector = sdkCss.slice(sdkCss.lastIndexOf("}", open) + 1, open);
  return { selector, body: sdkCss.slice(open, sdkCss.indexOf("}", at)) };
}

const ours = (() => {
  const start = appCss.indexOf("#w3a-parent-container");
  assert.ok(start > 0, "app.css lost the Web3Auth modal rule");
  const open = appCss.indexOf("{", start);
  return { selector: appCss.slice(start, open).trim(), body: appCss.slice(open, appCss.indexOf("}", open)) };
})();

const beats = (a: [number, number], b: [number, number]) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

test("the modal's container is the id our rule names", () => {
  assert.match(loginModal, /parent\.setAttribute\("id", "w3a-parent-container"\);/);
  assert.match(loginModal, /parent\.classList\.add\("w3a-parent-container"\);/);
});

test("every grey: the SDK declares it on its container, and our rule outranks that and sets a token", () => {
  const sdk = sdkRuleDeclaring("--app-gray-900");
  assert.match(sdk.selector, /^\.w3a-parent-container(?::not\(#\\\\#\))+$/, "greys moved off the container");
  for (const grey of GREYS) assert.ok(sdk.body.includes(`${grey}:`), `the SDK's grey rule lost ${grey}`);
  assert.ok(beats(specificity(ours.selector, OUR_NOT), specificity(sdk.selector, SDK_NOT)), `${ours.selector} no longer outranks ${sdk.selector}`);
  for (const grey of GREYS) assert.match(ours.body, new RegExp(`${grey}: var\\(--[a-z-]+\\);`), `${grey} is not mapped to a token`);
});

test("the font: the SDK's container font and its sans variable both lose to ours", () => {
  const font = sdkCss.match(/(\.w3a-parent-container(?::not\(#\\\\#\))+)\{font-family:Inter;/);
  assert.ok(font, "the SDK sets its container font somewhere else now");
  assert.ok(beats(specificity(ours.selector, OUR_NOT), specificity(font[1], SDK_NOT)));
  const sans = sdkRuleDeclaring("--wta-font-sans");
  assert.ok(beats(specificity(ours.selector, OUR_NOT), specificity(sans.selector, SDK_NOT)));
  assert.match(ours.body, /--wta-font-sans: var\(--font-body\);/);
  assert.match(ours.body, /\n  font-family: var\(--font-body\);/);
});

test("brand marks in colour: the SDK shows its colour image on hover only, and our rule shows it always (owner 2026-10-22)", () => {
  const list = read("../node_modules/@web3auth/modal/dist/lib.esm/packages/modal/src/ui/components/SocialLoginList/SocialLoginList.js").replace(/\s+/g, " ");
  // Apple, GitHub and X have no colour mark: both images are the white one.
  assert.match(list, /const hoverId = method === AUTH_CONNECTION\.APPLE \|\| method === AUTH_CONNECTION\.GITHUB \|\| method === AUTH_CONNECTION\.TWITTER \? imageId : `login-\$\{method\}-active`;/);
  assert.match(list, /id: "active-login-img", src: `https:\/\/images\.web3auth\.io\/\$\{hoverId\}\$\{extension\}`, alt: "active-login-img", className: "wta:hidden wta:size-5 wta:object-contain wta:group-hover:block"/);
  assert.match(list, /id: "login-img", src: `https:\/\/images\.web3auth\.io\/\$\{imageId\}\$\{extension\}`, alt: "login-img", className: "wta:block wta:size-5 wta:object-contain wta:group-hover:hidden"/);
  const prefix = "#w3a-parent-container:not(#\\#):not(#\\#):not(#\\#):not(#\\#):not(#\\#)";
  for (const [id, display] of [["#active-login-img", "block"], ["#login-img", "none"]] as const) {
    const at = appCss.indexOf(`${prefix} ${id} {`);
    assert.ok(at > 0, `app.css lost the ${id} rule`);
    assert.match(appCss.slice(at, appCss.indexOf("}", at)), new RegExp(`display: ${display};`));
  }
  // Theirs: the container class, four :not()s and utility classes. Ours: the
  // container id, five :not()s and the image's id - more ids, so ours wins.
  for (const util of [".wta\\\\:hidden{display:none", ".wta\\\\:block{display:block", ".wta\\\\:group-hover\\\\:block:is("]) {
    const at = sdkCss.indexOf(util);
    assert.ok(at > 0, `the SDK no longer has ${util}`);
    const selector = sdkCss.slice(sdkCss.lastIndexOf("}", at) + 1, at);
    assert.ok(specificity(selector.trim(), SDK_NOT)[0] < 7, `${selector} now carries as many ids as ours`);
  }
});

test("the accent is ours too: CSS maps the SDK's primary scale onto our accent tokens, since a theme option is paid (2026-10-22)", () => {
  const sdk = sdkRuleDeclaring("--app-primary-600");
  assert.ok(beats(specificity(ours.selector, OUR_NOT), specificity(sdk.selector, SDK_NOT)));
  for (const n of ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900"]) {
    assert.match(ours.body, new RegExp(`--app-primary-${n}: var\\(--accent[a-z-]*\\);`), `--app-primary-${n}`);
  }
  assert.match(ours.body, /--app-on-primary: var\(--accent-ink\);/);
  // Only the paid theme option paints these inline (loginModal.js), and we never pass it.
  assert.match(read("../node_modules/@web3auth/modal/dist/lib.esm/packages/modal/src/ui/loginModal.js"), /applyWhiteLabelTheme\(Color, rootElement, this\.uiConfig\.theme\);/);
});
