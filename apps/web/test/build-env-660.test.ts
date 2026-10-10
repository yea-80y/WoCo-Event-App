/**
 * A build carries the settings its code reads, and no others (#660).
 *
 * Any read of `import.meta.env` other than the exact `import.meta.env.VITE_X`
 * makes Vite emit the whole env object - every VITE_ setting on the build
 * machine - and leaves the bundler to trim it. A Web3Auth dependency's
 * `import.meta.env[name]` could not be trimmed, and shipped a key no code used
 * any more in the app and in every organiser site. The leak is in what the
 * bundler emits, so the build itself refuses it (vite-plugins/no-env-object.ts);
 * these tests pin the pieces.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { buildEnv } from "../src/lib/build-env.js";
import { hasEnvObject, withoutDependencyEnvRead } from "../vite-plugins/no-env-object.js";

const WEB = fileURLToPath(new URL("../", import.meta.url));
const SRC = join(WEB, "src");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|svelte)$/.test(name) ? [p] : [];
  });
}

// ---------------------------------------------------------------------------
// Our own reads
// ---------------------------------------------------------------------------

test("every import.meta read in the app is one Vite resolves to a single value", () => {
  const offenders: string[] = [];
  let reads = 0;
  for (const file of sourceFiles(SRC)) {
    const src = code(readFileSync(file, "utf8"));
    for (const m of src.matchAll(/\bimport\.meta\b(.{0,40})/g)) {
      // `.env.NAME` is the exact form; `.url` and `.glob(` are not the env.
      if (/^\.env\.[A-Za-z_]\w*/.test(m[1])) reads++;
      else if (!/^\.(?:url\b|glob\()/.test(m[1])) offenders.push(`${relative(SRC, file)}: import.meta${m[1].split("\n")[0]}`);
    }
  }
  assert.ok(reads >= 20, `only ${reads} env reads found - the scan is not seeing them`);
  assert.deepEqual(offenders, []);
});

test("a setting reads as absent where there is no Vite, and as itself where there is", () => {
  // The test runner is that place: `import.meta.env` does not exist here.
  assert.equal(buildEnv(() => (import.meta as unknown as { env: { VITE_X: string } }).env.VITE_X), undefined);
  assert.equal(buildEnv(() => "set"), "set");
  assert.equal(buildEnv(() => false), false);
});

// ---------------------------------------------------------------------------
// The build guard
// ---------------------------------------------------------------------------

test("the guard recognises the env object Vite emits, minified or not", () => {
  // Shape copied from a real production chunk (values replaced).
  assert.ok(hasEnvObject(`OTHER:"other"},nM={BASE_URL:"./",DEV:!1,MODE:"production",PROD:!0,SSR:!1,VITE_X:"v"};`));
  assert.ok(hasEnvObject(`const __vite_import_meta_env__ = {"VITE_X": "v", "BASE_URL": "./", "MODE": "site", "DEV": false, "PROD": true, "SSR": false};`));
  // Vite sorts the keys today; this is the order a Vite that stopped sorting could emit.
  assert.ok(hasEnvObject(`x={SSR:!1,BASE_URL:"./"}`));
});

test("the guard does not fire on code that merely names those keys", () => {
  assert.ok(!hasEnvObject(`const api={BASE_URL:"https://api.example.com",timeout:5}`));
  assert.ok(!hasEnvObject(`a={BASE_URL:"x"},b={SSR:!1}`), "two different objects");
  assert.ok(!hasEnvObject(`if(e.SSR)return;const u=cfg.BASE_URL`));
});

const TORUS = /[\\/]@toruslabs[\\/]base-controllers[\\/]dist[\\/]lib\.esm[\\/]utils[\\/]utils\.js$/;

test("a listed dependency's env read is cut, byte-length preserved", () => {
  const id = "/x/node_modules/@toruslabs/base-controllers/dist/lib.esm/utils/utils.js";
  const src = "// (import.meta.env)\nif ((a = import.meta.env) !== null && a[v]) return (b = import.meta.env)[v];";
  const out = withoutDependencyEnvRead(id, src);
  assert.ok(out && "code" in out);
  assert.doesNotMatch(out.code, /import\.meta\.env/);
  assert.equal(out.code.length, src.length, "columns shift and the source map lies");
  assert.match(out.code, /\(a = undefined\s+\) !== null/);
});

test("a listed dependency that changed shape fails the build instead of being trusted", () => {
  const id = "/x/node_modules/@toruslabs/base-controllers/dist/lib.esm/utils/utils.js";
  for (const src of ["import.meta.env import.meta.env", "import.meta.env ".repeat(4)]) {
    const out = withoutDependencyEnvRead(id, src);
    assert.ok(out && "error" in out, `accepted ${src.split("import.meta.env").length - 1} reads`);
  }
});

test("an unlisted file is never rewritten", () => {
  assert.equal(withoutDependencyEnvRead("/x/src/lib/sub-ens/rpc.ts", "import.meta.env.VITE_X"), null);
  assert.equal(withoutDependencyEnvRead("/x/node_modules/@toruslabs/base-controllers/dist/lib.esm/utils/other.js", "import.meta.env"), null);
});

test("the installed Web3Auth dependency is still the shape the rewrite expects", () => {
  // A dependency upgrade that moves or adds a read fails here as well as in the build.
  // Resolved through the package that makes the call, so this is the copy it uses.
  const require = createRequire(join(WEB, "package.json"));
  const resolveFrom = (name: string, from: string) => dirname(require.resolve(`${name}/package.json`, { paths: [from] }));
  const caller = resolveFrom("@toruslabs/ethereum-controllers", WEB);
  const file = join(resolveFrom("@toruslabs/base-controllers", caller), "dist/lib.esm/utils/utils.js");
  assert.match(file, TORUS);
  const out = withoutDependencyEnvRead(file, readFileSync(file, "utf8"));
  assert.ok(out && "code" in out, out && "error" in out ? out.error : "file not recognised");

  // The rewrite changes nothing only while its one caller asks for a setting no build sets.
  const constants = readFileSync(join(caller, "dist/lib.esm/utils/constants.js"), "utf8");
  assert.deepEqual([...constants.matchAll(/getEnvVariable\(([^)]*)\)/g)].map((m) => m[1]), ['"VITE_APP_INFURA_PROJECT_KEY"']);
});

test("every bundle this app builds runs the guard", () => {
  for (const config of ["vite.config.ts", "vite.multisite.config.ts", "vite.site.config.ts", "vite.scanner.config.ts"]) {
    const src = code(readFileSync(join(WEB, config), "utf8"));
    assert.match(src, /plugins:\s*\[[\s\S]*\bnoEnvObject\(\)/, config);
  }
});
