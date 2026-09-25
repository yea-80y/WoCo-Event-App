/**
 * Fail the build if any chunk carries Vite's whole env object (#660).
 *
 * Vite inlines `import.meta.env.VITE_X` as that one value. Any other form - in
 * our code or a dependency's - makes it emit an object holding EVERY setting
 * loaded from the build machine's .env, and Rollup trims only the keys that are
 * provably unread. A dependency reading `import.meta.env[name]` defeats that, so
 * a key nothing used any more shipped in the app and in every organiser site,
 * and no test could see it: the leak is in what the bundler emits, not in any
 * source line that reads a secret.
 *
 * So this checks what ships. Vite always puts `BASE_URL` and `SSR` in that
 * object, and nothing else we bundle has both keys in one literal. The error
 * names the chunk, never its contents - the contents are the settings.
 */
import type { Plugin } from "vite";

/**
 * Dependencies that read `import.meta.env[name]` with a name chosen at run time,
 * which Vite can only serve by inlining everything. Each entry cuts the env out
 * of one file, and fails the build if that file changes shape, so a dependency
 * upgrade is looked at again rather than trusted.
 */
const DEPENDENCY_ENV_READS: { file: RegExp; occurrences: number; why: string }[] = [
  {
    // Web3Auth. `getEnvVariable(name)` falls back to process.env when the env
    // has no such key, and its one caller asks for VITE_APP_INFURA_PROJECT_KEY,
    // which no build of ours sets - so this changes no value it can return.
    file: /[\\/]@toruslabs[\\/]base-controllers[\\/]dist[\\/]lib\.esm[\\/]utils[\\/]utils\.js$/,
    // Two reads and the comment above them.
    occurrences: 3,
    why: "getEnvVariable - its one caller reads VITE_APP_INFURA_PROJECT_KEY, which we never set",
  },
];

const KEY = (name: string) => String.raw`["'\`]?\b${name}["'\`]?\s*:`;
// Within one brace-free span: the keys of a single object literal. Vite sorts
// the keys, so BASE_URL comes first and only DEV, MODE and PROD sit before SSR -
// no setting's value can fall in between. The reverse order is for a Vite that
// stops sorting.
const ENV_OBJECT = new RegExp(
  `${KEY("BASE_URL")}[^{}]*?${KEY("SSR")}|${KEY("SSR")}[^{}]*?${KEY("BASE_URL")}`,
);

/** Whether this built code contains the whole env object. */
export function hasEnvObject(code: string): boolean {
  return ENV_OBJECT.test(code);
}

/** A listed dependency's code with its env read removed, or why that failed. */
export function withoutDependencyEnvRead(
  id: string,
  code: string,
): { code: string } | { error: string } | null {
  const entry = DEPENDENCY_ENV_READS.find((d) => d.file.test(id));
  if (!entry) return null;
  const found = code.split("import.meta.env").length - 1;
  if (found !== entry.occurrences) {
    return {
      error:
        `${id} reads import.meta.env ${found} time(s), expected ${entry.occurrences} (${entry.why}). ` +
        `The dependency changed: check what it reads now before updating vite-plugins/no-env-object.ts (#660).`,
    };
  }
  // Padded to the same length, as Vite pads its own, so columns - and the
  // source map - are unchanged.
  return { code: code.replaceAll("import.meta.env", "undefined".padEnd("import.meta.env".length)) };
}

export function noEnvObject(): Plugin {
  return {
    name: "woco:no-env-object",
    apply: "build",
    // Before Vite's own env substitution sees the file.
    enforce: "pre",
    transform(code, id) {
      const result = withoutDependencyEnvRead(id, code);
      if (!result) return null;
      if ("error" in result) this.error(result.error);
      return { code: result.code, map: null };
    },
    generateBundle(_options, bundle) {
      const offenders = Object.values(bundle)
        .filter((out) => out.type === "chunk" && hasEnvObject(out.code))
        .map((out) => out.fileName);
      if (offenders.length === 0) return;
      this.error(
        `the whole import.meta.env object is inlined into ${offenders.join(", ")} - every VITE_ setting ` +
          `on this machine would ship. Read settings only as the exact expression ` +
          "`import.meta.env.VITE_X` (src/lib/build-env.ts); `?.`, a cast of the object or passing it " +
          "anywhere inlines all of them (#660).",
      );
    },
  };
}
