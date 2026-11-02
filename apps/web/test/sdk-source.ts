// Reads a dependency's shipped source for the tests that pin SDK behaviour.
//
// npm places a package under apps/web/node_modules or hoists it to the root as the
// lockfile shifts: the @web3auth/modal 11.4.2 -> 11.4.3 patch moved an unchanged
// @web3auth/auth 11.8.3 to the root (2026-11-02), and a fixed path then read nothing.
// Look the way Node resolves from apps/web: its own node_modules first, then the root.
import { existsSync, readFileSync } from "node:fs";

const ROOTS = ["../node_modules/", "../../../node_modules/"].map((r) => new URL(r, import.meta.url));

export function sdkPath(rel: string): URL {
  for (const root of ROOTS) {
    const url = new URL(rel, root);
    if (existsSync(url)) return url;
  }
  throw new Error(`not in apps/web or root node_modules: ${rel}`);
}

export const readSdk = (rel: string): string => readFileSync(sdkPath(rel), "utf8");
