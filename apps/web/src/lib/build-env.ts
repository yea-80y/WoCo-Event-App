/**
 * Read one build-time setting so the bundle carries THAT value and nothing else (#660).
 *
 * Vite replaces the exact expression `import.meta.env.VITE_X` with its value. Any
 * other form - `import.meta.env?.VITE_X`, `import.meta.env as Record<...>` - makes
 * it emit the whole env object, every VITE_ setting on the build machine, and
 * leaves the bundler to trim it. Rollup does trim the keys nobody reads by name,
 * but a key chosen at run time, or the object passed anywhere, keeps all of them.
 * That is how a key no code used any more shipped in the app and in every
 * organiser site (through a dependency - see vite-plugins/no-env-object.ts).
 *
 * So pass the exact expression in a thunk: `buildEnv(() => import.meta.env.VITE_X)`.
 * Under the node test runner `import.meta.env` does not exist, the read throws, and
 * the setting reads as absent - the same as a build that never set it.
 * `vite-plugins/no-env-object.ts` fails any build that still inlines the object.
 */
export function buildEnv<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
